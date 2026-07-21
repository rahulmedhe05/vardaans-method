const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const express = require("express");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { parse } = require("csv-parse/sync");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// Puppeteer's downloaded Chromium is missing system libs on Nix-based hosts
// (Replit, Railway). Prefer a system-installed Chromium if one is present.
// Uses `command -v` via /bin/sh rather than `which`, since minimal images
// (Nixpacks/Debian-slim) don't always ship a `which` binary.
function findChromiumExecutable() {
  if (process.env.CHROME_BIN) {
    console.log(`[chromium] using CHROME_BIN=${process.env.CHROME_BIN}`);
    return process.env.CHROME_BIN;
  }

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log(`[chromium] using PUPPETEER_EXECUTABLE_PATH=${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
  console.log(`[chromium] PATH=${process.env.PATH || ""}`);
  console.log(`[chromium] checking shell candidates: ${candidates.join(", ")}`);
  try {
    const cmd = candidates.map((bin) => `command -v ${bin}`).join(" || ");
    const found = execSync(`${cmd} || true`, { shell: "/bin/sh" }).toString().trim().split("\n")[0];
    if (found) {
      console.log(`[chromium] found system binary via shell: ${found}`);
      return found;
    }
  } catch (err) {
    console.log(`[chromium] shell lookup failed: ${err.message}`);
  }

  // Fall back to scanning common absolute paths directly.
  const knownPaths = [
    "/run/current-system/sw/bin/chromium",
    "/etc/profiles/per-user/root/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/root/.nix-profile/bin/chromium",
    "/root/.nix-profile/bin/chromium-browser",
    "/root/.nix-profile/bin/chromium",
    "/nix/var/nix/profiles/default/bin/chromium",
    "/nix/var/nix/profiles/default/bin/chromium-browser",
  ];
  for (const p of knownPaths) {
    console.log(`[chromium] checking known path: ${p}`);
    if (fs.existsSync(p)) {
      console.log(`[chromium] found system binary at known path: ${p}`);
      return p;
    }
  }

  const nixStoreBinary = findChromiumInNixStore();
  if (nixStoreBinary) {
    console.log(`[chromium] found system binary in /nix/store: ${nixStoreBinary}`);
    return nixStoreBinary;
  }

  console.log("[chromium] no system Chromium found, falling back to Puppeteer's bundled binary");
  return undefined;
}

function findChromiumInNixStore() {
  const storeDir = "/nix/store";
  const binaryNames = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];

  try {
    if (!fs.existsSync(storeDir)) return undefined;

    const entries = fs.readdirSync(storeDir)
      .filter((name) => /chromium|chrome/i.test(name))
      .sort();

    for (const entry of entries) {
      for (const binName of binaryNames) {
        const candidate = path.join(storeDir, entry, "bin", binName);
        console.log(`[chromium] checking nix store candidate: ${candidate}`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch (err) {
    console.log(`[chromium] failed to inspect /nix/store: ${err.message}`);
  }

  return undefined;
}

const DATA_DIR = process.env.APP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const AUTH_DIR = path.join(DATA_DIR, ".wwebjs_auth");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.csv");
const MESSAGE_FILE = path.join(DATA_DIR, "message.txt");
const OPTOUT_FILE = path.join(DATA_DIR, "optout.csv");
const LOG_FILE = path.join(DATA_DIR, "sent-log.json");
const IMAGE_FILE = path.join(DATA_DIR, "campaign-image.bin");
const IMAGE_META_FILE = path.join(DATA_DIR, "campaign-image.json");
const CAMPAIGN_TIMING_FILE = path.join(DATA_DIR, "campaign-timing.json");
const WWEBJS_SESSION_DIR = path.join(AUTH_DIR, "session");
const SESSION_RECOVERY_MARKER = path.join(DATA_DIR, ".whatsapp-session-recovery-v1");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });
console.log(`[storage] using data dir: ${DATA_DIR}`);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function loadCsv(file) {
  if (!fs.existsSync(file)) return [];
  return parse(fs.readFileSync(file, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch (err) {
    console.log(`[storage] failed to read sent log, starting with an empty log: ${err.message}`);
    return {};
  }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function loadImageMeta() {
  if (!fs.existsSync(IMAGE_FILE) || !fs.existsSync(IMAGE_META_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(IMAGE_META_FILE, "utf8"));
  } catch (err) {
    return null;
  }
}

const DEFAULT_CAMPAIGN_TIMING = {
  msgMinDelay: 20,
  msgMaxDelay: 60,
  batchSize: 20,
  batchMinDelay: 300,
  batchMaxDelay: 600,
};

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function sanitizeCampaignTiming(input = {}) {
  const msgMinDelay = clampNumber(input.msgMinDelay, DEFAULT_CAMPAIGN_TIMING.msgMinDelay, 1, 3600);
  const msgMaxDelay = clampNumber(input.msgMaxDelay, DEFAULT_CAMPAIGN_TIMING.msgMaxDelay, msgMinDelay, 3600);
  const batchMinDelay = clampNumber(input.batchMinDelay, DEFAULT_CAMPAIGN_TIMING.batchMinDelay, 0, 86400);
  const batchMaxDelay = clampNumber(input.batchMaxDelay, DEFAULT_CAMPAIGN_TIMING.batchMaxDelay, batchMinDelay, 86400);
  return {
    msgMinDelay,
    msgMaxDelay,
    batchSize: Math.round(clampNumber(input.batchSize, DEFAULT_CAMPAIGN_TIMING.batchSize, 1, 500)),
    batchMinDelay,
    batchMaxDelay,
  };
}

function loadCampaignTiming() {
  if (!fs.existsSync(CAMPAIGN_TIMING_FILE)) return { ...DEFAULT_CAMPAIGN_TIMING };
  try {
    return sanitizeCampaignTiming(JSON.parse(fs.readFileSync(CAMPAIGN_TIMING_FILE, "utf8")));
  } catch (err) {
    return { ...DEFAULT_CAMPAIGN_TIMING };
  }
}

function formatCampaignTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: process.env.APP_TIME_ZONE || "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function normalizeNumber(raw) {
  const digits = String(raw).replace(/[^\d]/g, "");
  const defaultCountryCode = String(process.env.DEFAULT_COUNTRY_CODE || "91").replace(/[^\d]/g, "");
  return digits.length === 10 && defaultCountryCode ? `${defaultCountryCode}${digits}` : digits;
}

async function resolveRecipientIds(targetClient, phone) {
  const phoneId = `${phone}@c.us`;
  const candidateIds = [];
  const lookupTimeoutMs = Number(process.env.WHATSAPP_LOOKUP_TIMEOUT_MS) || 20000;

  // These Puppeteer-evaluated lookups have no built-in timeout. Right after a
  // browser recovery the WhatsApp Store isn't always ready to answer them, so
  // without a timeout they can hang indefinitely and wedge the whole campaign.
  const numberId = await withTimeout(
    targetClient.getNumberId(phone),
    lookupTimeoutMs,
    `WhatsApp did not resolve ${phone} within ${Math.round(lookupTimeoutMs / 1000)} seconds.`,
  );
  if (!numberId?._serialized) return [];
  candidateIds.push(numberId._serialized);

  // WhatsApp now routes many users through a LID. Resolve it before opening
  // the chat so sendMessage does not fail in findOrCreateLatestChat.
  if (typeof targetClient.getContactLidAndPhone === "function") {
    try {
      const [resolved] = await withTimeout(
        targetClient.getContactLidAndPhone([phoneId]),
        lookupTimeoutMs,
        `WhatsApp did not resolve a LID for ${phone} within ${Math.round(lookupTimeoutMs / 1000)} seconds.`,
      );
      if (resolved?.pn) candidateIds.push(resolved.pn);
      if (resolved?.lid) candidateIds.push(resolved.lid);
    } catch (err) {
      if (err.code === "WA_SEND_TIMEOUT" || isRecoverableBrowserError(err)) throw err;
      console.log(`[recipient] LID lookup failed for ${phone}: ${err.message}`);
    }
  }

  candidateIds.push(phoneId);
  return [...new Set(candidateIds.filter(Boolean))];
}

function describeRecipientIds(recipientIds) {
  return recipientIds.map((id) => id.replace(/@(c\.us|lid|s\.whatsapp\.net)$/, "@$1")).join(", ");
}

function renderTemplate(template, row) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => row[key] ?? "");
}

function writeContactsCsv(rows) {
  const header = "name,phone";
  const lines = rows.map((r) => `${String(r.name || "").replace(/[\r\n,]+/g, " ").trim()},${normalizeNumber(r.phone)}`);
  fs.writeFileSync(CONTACTS_FILE, [header, ...lines].join("\n") + "\n");
}

function listQueuedContacts(contacts = loadCsv(CONTACTS_FILE), log = loadLog(), optouts = new Set(loadCsv(OPTOUT_FILE).map((r) => normalizeNumber(r.phone)))) {
  return contacts
    .map((contact) => ({ name: contact.name || "", phone: normalizeNumber(contact.phone) }))
    .filter((contact) => {
      if (!contact.phone || optouts.has(contact.phone)) return false;
      return !["sent", "not_registered", "error"].includes(log[contact.phone]?.status);
    });
}

let campaignQueueState = { total: 0, index: 0, current: null, next: [], running: false, dryRun: false };

function queueSnapshot(queue, index = 0, running = false, dryRun = false) {
  const safeIndex = Math.max(0, Math.min(index, queue.length));
  return {
    total: queue.length,
    index: safeIndex,
    current: running && safeIndex < queue.length ? queue[safeIndex] : null,
    next: queue.slice(running ? safeIndex + 1 : safeIndex, (running ? safeIndex + 1 : safeIndex) + 20),
    running,
    dryRun,
  };
}

function emitCampaignQueue(queue, index = 0, running = false, dryRun = false) {
  campaignQueueState = queueSnapshot(queue, index, running, dryRun);
  io.emit("campaign-queue", campaignQueueState);
}

// ---- REST API ----

app.get("/api/state", (req, res) => {
  const contacts = loadCsv(CONTACTS_FILE);
  const optouts = new Set(loadCsv(OPTOUT_FILE).map((r) => normalizeNumber(r.phone)));
  const log = loadLog();
  const message = fs.existsSync(MESSAGE_FILE) ? fs.readFileSync(MESSAGE_FILE, "utf8") : "";
  const image = loadImageMeta();
  const queue = listQueuedContacts(contacts, log, optouts);

  const rows = contacts.map((c) => {
    const phone = normalizeNumber(c.phone);
    let status = "pending";
    if (optouts.has(phone)) status = "opted_out";
    else if (log[phone]?.status) status = log[phone].status;
    return { name: c.name || "", phone, status };
  });

  res.json({
    contacts: rows,
    message,
    whatsappReady,
    connectInProgress,
    qrDataUrl: lastQrDataUrl,
    pairingCode: lastPairingCode,
    pairingPhone: lastPairingPhone,
    sending,
    campaignPaused,
    timing: loadCampaignTiming(),
    queue: sending ? campaignQueueState : queueSnapshot(queue),
    image: image ? { ...image, url: "/api/message/image" } : null,
  });
});

app.post("/api/message", (req, res) => {
  const { message } = req.body;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message cannot be empty." });
  }
  fs.writeFileSync(MESSAGE_FILE, message);
  res.json({ ok: true });
});

app.get("/api/message/image", (req, res) => {
  const image = loadImageMeta();
  if (!image) return res.status(404).json({ error: "No image attached." });
  res.type(image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(IMAGE_FILE);
});

app.post("/api/message/image", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an image first." });
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowedTypes.has(req.file.mimetype)) {
    return res.status(400).json({ error: "Use a JPEG, PNG, or WebP image." });
  }
  const image = {
    name: path.basename(req.file.originalname).slice(0, 120),
    mimeType: req.file.mimetype,
    size: req.file.size,
  };
  fs.writeFileSync(IMAGE_FILE, req.file.buffer);
  fs.writeFileSync(IMAGE_META_FILE, JSON.stringify(image, null, 2));
  res.json({ ok: true, image: { ...image, url: "/api/message/image" } });
});

app.delete("/api/message/image", (req, res) => {
  if (fs.existsSync(IMAGE_FILE)) fs.unlinkSync(IMAGE_FILE);
  if (fs.existsSync(IMAGE_META_FILE)) fs.unlinkSync(IMAGE_META_FILE);
  res.json({ ok: true });
});

app.post("/api/contacts/paste", (req, res) => {
  const { text, mode } = req.body; // mode: "append" | "replace"
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "No contacts provided." });
  }

  const parsed = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length >= 2) return { name: parts[0], phone: parts[1] };
      return { name: "", phone: parts[0] };
    })
    .filter((c) => normalizeNumber(c.phone).length >= 8);

  let existing = mode === "append" ? loadCsv(CONTACTS_FILE) : [];
  const seen = new Map(existing.map((c) => [normalizeNumber(c.phone), c]));
  for (const c of parsed) {
    seen.set(normalizeNumber(c.phone), c);
  }

  writeContactsCsv([...seen.values()]);
  res.json({ ok: true, count: seen.size });
});

app.post("/api/contacts/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const rows = parse(req.file.buffer.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    const cleaned = rows
      .map((r) => ({ name: r.name || r.Name || "", phone: r.phone || r.Phone || r.number || r.Number || "" }))
      .filter((c) => normalizeNumber(c.phone).length >= 8);
    if (cleaned.length === 0) {
      return res.status(400).json({ error: "CSV needs 'name' and 'phone' columns." });
    }
    writeContactsCsv(cleaned);
    res.json({ ok: true, count: cleaned.length });
  } catch (err) {
    res.status(400).json({ error: "Could not parse CSV: " + err.message });
  }
});

app.post("/api/contacts/delete", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "No phone provided." });
  const target = normalizeNumber(phone);
  const remaining = loadCsv(CONTACTS_FILE).filter((c) => normalizeNumber(c.phone) !== target);
  writeContactsCsv(remaining);
  res.json({ ok: true, count: remaining.length });
});

// Removes contacts whose number starts with 0 (a local-format leading zero,
// invalid once digits-only — real numbers need a country code instead).
app.post("/api/contacts/clean-invalid", (req, res) => {
  const contacts = loadCsv(CONTACTS_FILE);
  const kept = contacts.filter((c) => {
    const n = normalizeNumber(c.phone);
    return n.length > 0 && !n.startsWith("0");
  });
  const removed = contacts.length - kept.length;
  writeContactsCsv(kept);
  res.json({ ok: true, removed, remaining: kept.length });
});

app.post("/api/contacts/clear", (req, res) => {
  const removed = loadCsv(CONTACTS_FILE).length;
  writeContactsCsv([]);
  res.json({ ok: true, removed });
});

app.get("/api/chatbot", (req, res) => {
  res.status(410).json({ error: "Chatbot is temporarily disabled." });
});

app.put("/api/chatbot", (req, res) => {
  res.status(410).json({ error: "Chatbot is temporarily disabled." });
});

app.delete("/api/chatbot/activity", (req, res) => {
  res.status(410).json({ error: "Chatbot is temporarily disabled." });
});

app.put("/api/timing", (req, res) => {
  const timing = sanitizeCampaignTiming(req.body);
  fs.writeFileSync(CAMPAIGN_TIMING_FILE, JSON.stringify(timing, null, 2));
  io.emit("timing-settings", timing);
  res.json({ ok: true, timing });
});

// ---- WhatsApp client ----

let client = null;
let whatsappReady = false;
let sending = false;
let stopCampaignRequested = false;
let campaignPaused = false;
let cancelCampaignDelay = null;
let resumeCampaignWait = null;
let lastQrDataUrl = null;
let connectInProgress = false;
let lastPairingCode = null;
let lastPairingPhone = null;
let clientInitPromise = null;
let clientResetPromise = null;
let forcedReconnectPromise = null;
let browserRecoveryPromise = null;
let sessionInitTimedOut = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForCampaignDelay(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelCampaignDelay === finish) cancelCampaignDelay = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    cancelCampaignDelay = finish;
    if (stopCampaignRequested) finish();
  });
}

async function waitWhileCampaignPaused() {
  while (campaignPaused && !stopCampaignRequested) {
    await new Promise((resolve) => {
      resumeCampaignWait = resolve;
    });
    resumeCampaignWait = null;
  }
}

function emitCampaignState() {
  io.emit("campaign-state", { sending, paused: campaignPaused });
}

function stopActiveCampaign(reason) {
  if (!sending && !campaignPaused && !stopCampaignRequested) return;
  sending = false;
  stopCampaignRequested = false;
  campaignPaused = false;
  cancelCampaignDelay = null;
  if (resumeCampaignWait) resumeCampaignWait();
  resumeCampaignWait = null;
  io.emit("sending-state", false);
  emitCampaignState();
  if (reason) io.emit("log", reason);
}

function isRecoverableBrowserError(err) {
  const message = String(err?.message || err);
  return /detached Frame|frame was detached|Execution context was destroyed|Cannot find context|Target closed|Session closed|Protocol error|Navigation failed/i.test(message);
}

function markWhatsappUnavailable(reason, targetClient = client) {
  if (targetClient && client && targetClient !== client) return;
  whatsappReady = false;
  connectInProgress = false;
  lastQrDataUrl = null;
  lastPairingCode = null;
  lastPairingPhone = null;
  if (targetClient === client) client = null;
  io.emit("not-ready");
  io.emit("log", `WhatsApp browser became unavailable (${reason}). Reconnect WhatsApp before sending again.`);
}

function attachBrowserGuards(targetClient) {
  const browser = targetClient?.pupBrowser;
  if (!browser || browser.__vardaansGuardAttached) return;
  browser.__vardaansGuardAttached = true;
  browser.on("disconnected", () => {
    if (client !== targetClient) return;
    markWhatsappUnavailable("Chromium disconnected", targetClient);
    stopActiveCampaign("Campaign stopped because the WhatsApp browser closed.");
  });
}

function getMessageId(message) {
  return message?.id?._serialized || message?.id?.id || null;
}

function removeClientListener(targetClient, eventName, listener) {
  if (typeof targetClient.off === "function") targetClient.off(eventName, listener);
  else if (typeof targetClient.removeListener === "function") targetClient.removeListener(eventName, listener);
}

function waitForServerAck(targetClient, sentMessage, timeoutMs = Number(process.env.WHATSAPP_ACK_TIMEOUT_MS) || 45000) {
  const sentId = getMessageId(sentMessage);
  if (!sentId) throw new Error("WhatsApp did not return a message id for this send.");
  if (sentMessage.ack >= 1) return Promise.resolve(sentMessage.ack);
  if (sentMessage.ack === -1) throw new Error("WhatsApp rejected the message before sending.");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeClientListener(targetClient, "message_ack", onAck);
      reject(new Error(`WhatsApp did not confirm server delivery within ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    function finish(err, ack) {
      clearTimeout(timer);
      removeClientListener(targetClient, "message_ack", onAck);
      if (err) reject(err);
      else resolve(ack);
    }

    function onAck(message, ack) {
      if (getMessageId(message) !== sentId) return;
      if (ack === -1) finish(new Error("WhatsApp rejected the message."));
      else if (ack >= 1) finish(null, ack);
    }

    targetClient.on("message_ack", onAck);
  });
}

async function findRecentOutgoingMessage(targetClient, chatId, expectedText, sinceMs) {
  const lookupDelayMs = Number(process.env.WHATSAPP_CREATED_LOOKUP_DELAY_MS) || 2500;
  if (lookupDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, lookupDelayMs));
  }

  return targetClient.pupPage.evaluate(
    async ({ targetChatId, text, startedAt }) => {
      const chat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
      if (!chat?.msgs?.getModelsArray) return null;

      const startedSeconds = Math.floor((startedAt - 5000) / 1000);
      const candidates = chat.msgs
        .getModelsArray()
        .filter((message) => {
          const fromMe = message?.id?.fromMe === true;
          const recent = Number(message?.t || 0) >= startedSeconds;
          const body = message?.body || message?.caption || "";
          return fromMe && recent && (!text || body === text);
        })
        .sort((a, b) => Number(b?.t || 0) - Number(a?.t || 0));

      return candidates[0] ? window.WWebJS.getMessageModel(candidates[0]) : null;
    },
    { targetChatId: chatId, text: expectedText, startedAt: sinceMs },
  );
}

async function sendMessageAndVerifyCreated(targetClient, chatId, content, options, expectedText, timeoutMs, timeoutMessage) {
  const startedAt = Date.now();
  const sentMessage = await withTimeout(
    targetClient.sendMessage(chatId, content, { ...options, waitUntilMsgSent: true }),
    timeoutMs,
    timeoutMessage,
  );
  if (sentMessage) return sentMessage;

  const recoveredMessage = await findRecentOutgoingMessage(targetClient, chatId, expectedText, startedAt);
  if (recoveredMessage) {
    console.log(`[send] recovered created outgoing message ${getMessageId(recoveredMessage)} for ${chatId}`);
    return recoveredMessage;
  }
  return null;
}

async function sendViaPhoneComposeFallback(targetClient, phone, body, timeoutMs) {
  const page = targetClient.pupPage;
  if (!page || page.isClosed()) return null;

  const startedAt = Date.now();
  const url = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(body)}&app_absent=0`;
  await withTimeout(
    page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
    timeoutMs,
    `WhatsApp compose fallback did not open within ${Math.round(timeoutMs / 1000)} seconds.`,
  );

  await withTimeout(
    page.waitForFunction(
      () => {
        const text = document.body?.innerText || "";
        return /Phone number shared via url is invalid/i.test(text)
          || /not on WhatsApp/i.test(text)
          || document.querySelector('[data-icon="send"]')
          || document.querySelector('span[data-icon="send"]')
          || [...document.querySelectorAll('button, [role="button"]')].some((el) => (el.getAttribute("aria-label") || "").toLowerCase() === "send");
      },
      { timeout: timeoutMs },
    ),
    timeoutMs,
    `WhatsApp compose fallback did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`,
  );

  const invalidNumber = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return /Phone number shared via url is invalid/i.test(text) || /not on WhatsApp/i.test(text);
  });
  if (invalidNumber) return false;

  const clicked = await page.evaluate(() => {
    const sendIcon = document.querySelector('[data-icon="send"], span[data-icon="send"]');
    const sendButton = sendIcon?.closest('button, [role="button"]')
      || [...document.querySelectorAll('button, [role="button"]')].find((el) => (el.getAttribute("aria-label") || "").toLowerCase() === "send");
    if (!sendButton) return false;
    sendButton.click();
    return true;
  });
  if (!clicked) return null;

  await new Promise((resolve) => setTimeout(resolve, 3000));
  return findRecentOutgoingMessage(targetClient, `${phone}@c.us`, body, startedAt);
}

function withTimeout(promise, timeoutMs, errorMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(errorMessage);
      err.code = "WA_SEND_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function listSessionChromePids() {
  try {
    const sessionArg = `--user-data-dir=${WWEBJS_SESSION_DIR}`;
    const output = execSync("ps -ax -o pid=,command=", { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter((entry) => {
        if (!entry || !Number.isInteger(entry.pid) || entry.pid === process.pid) return false;
        return entry.command.includes(sessionArg) && /(Chromium|Chrome|chrome)/.test(entry.command);
      })
      .map((entry) => entry.pid);
  } catch (err) {
    console.log(`[chromium] failed to inspect running session browsers: ${err.message}`);
    return [];
  }
}

async function cleanupOrphanSessionBrowsers() {
  const pids = listSessionChromePids();
  if (pids.length === 0) return 0;

  io.emit("log", `Closing ${pids.length} leftover WhatsApp browser process(es)...`);
  console.log(`[chromium] terminating leftover session browser pids: ${pids.join(", ")}`);

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if (err.code !== "ESRCH") {
        console.log(`[chromium] failed to SIGTERM pid ${pid}: ${err.message}`);
      }
    }
  }

  await delay(1200);

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch (err) {
      if (err.code !== "ESRCH") {
        console.log(`[chromium] failed to SIGKILL pid ${pid}: ${err.message}`);
      }
    }
  }

  await delay(300);
  return pids.length;
}

async function cleanupStaleSessionLocks() {
  if (!fs.existsSync(WWEBJS_SESSION_DIR)) return 0;

  const lockFile = path.join(WWEBJS_SESSION_DIR, "SingletonLock");
  let lockOwner = "";
  try {
    lockOwner = fs.readlinkSync(lockFile);
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "EINVAL") {
      console.log(`[chromium] failed to inspect session lock: ${err.message}`);
    }
  }

  // Railway briefly overlaps old and new containers during a deployment. Give
  // the previous container time to stop Chromium before clearing its lock.
  if (lockOwner && !lockOwner.startsWith(`${os.hostname()}-`)) {
    const graceMs = Math.max(0, Number(process.env.CHROMIUM_LOCK_GRACE_MS) || 12000);
    console.log(`[chromium] session lock belongs to ${lockOwner}; waiting ${graceMs}ms`);
    io.emit("log", "Waiting for the previous WhatsApp browser to shut down...");
    await delay(graceMs);
  }

  let removed = 0;
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    const file = path.join(WWEBJS_SESSION_DIR, name);
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.log(`[chromium] failed to remove stale ${name}: ${err.message}`);
      }
    }
  }

  if (removed > 0) {
    console.log(`[chromium] removed ${removed} stale session lock file(s)`);
  }
  return removed;
}

async function initializeWithTimeout(targetClient, startupSignal) {
  const timeoutMs = Math.max(30000, Number(process.env.WHATSAPP_INIT_TIMEOUT_MS) || 90000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`WhatsApp initialization timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      err.code = "WHATSAPP_INIT_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  try {
    const launchFailure = targetClient.initialize().then(() => new Promise(() => {}));
    return await Promise.race([startupSignal, launchFailure, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function initClientUnlocked(launchAttempt = 1) {
  if (client) {
    io.emit("log", "Already connecting/connected.");
    return;
  }
  connectInProgress = true;
  whatsappReady = false;
  lastQrDataUrl = null;
  lastPairingCode = null;
  lastPairingPhone = null;
  io.emit("log", "Launching WhatsApp session, this can take a few seconds...");
  await cleanupOrphanSessionBrowsers();
  await cleanupStaleSessionLocks();

  const chromiumPath = findChromiumExecutable();
  io.emit("log", chromiumPath ? `Using Chromium at: ${chromiumPath}` : "No system Chromium found — using Puppeteer's bundled binary (may fail on this host).");
  console.log(`[chromium] platform=${process.platform} arch=${process.arch}`);
  console.log(`[chromium] session dir=${WWEBJS_SESSION_DIR}`);
  console.log(`[chromium] data dir=${DATA_DIR}`);

  const newClient = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      executablePath: chromiumPath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-first-run",
        "--no-zygote",
      ],
    },
  });
  client = newClient;
  let settleStartup;
  const startupSignal = new Promise((resolve) => {
    settleStartup = resolve;
  });

  newClient.on("qr", async (qr) => {
    if (client !== newClient) return;
    settleStartup("qr");
    const dataUrl = await QRCode.toDataURL(qr);
    lastQrDataUrl = dataUrl;
    lastPairingCode = null;
    lastPairingPhone = null;
    io.emit("qr", dataUrl);
    io.emit("log", "Scan the QR code with WhatsApp > Linked Devices.");
  });

  newClient.on("code", (code) => {
    if (client !== newClient) return;
    settleStartup("code");
    lastPairingCode = code;
    io.emit("pairing-code", { code, phone: lastPairingPhone });
    io.emit("log", `Pairing code ready for ${lastPairingPhone || "phone number"}.`);
  });

  newClient.on("loading_screen", (percent) => {
    if (client !== newClient) return;
    io.emit("log", `Loading WhatsApp Web... ${percent}%`);
  });

  newClient.on("ready", () => {
    if (client !== newClient) return;
    settleStartup("ready");
    sessionInitTimedOut = false;
    whatsappReady = true;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
    attachBrowserGuards(newClient);
    io.emit("ready");
    io.emit("log", "WhatsApp connected.");
  });

  newClient.on("auth_failure", (msg) => {
    if (client !== newClient) return;
    settleStartup("auth_failure");
    io.emit("log", `Authentication failed: ${msg}. Try connecting again.`);
    stopActiveCampaign("Campaign stopped because WhatsApp authentication failed.");
    client = null;
    whatsappReady = false;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
  });

  newClient.on("disconnected", (reason) => {
    if (client !== newClient) return;
    settleStartup("disconnected");
    stopActiveCampaign("Campaign stopped because WhatsApp disconnected.");
    whatsappReady = false;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
    io.emit("log", `WhatsApp disconnected: ${reason}`);
    client = null;
  });

  try {
    await initializeWithTimeout(newClient, startupSignal);
  } catch (err) {
    io.emit("log", `Failed to start WhatsApp session: ${err.message}`);
    console.log(`[chromium] initialize failed stack: ${err.stack || err.message}`);
    if (client === newClient) {
      sessionInitTimedOut = err.code === "WHATSAPP_INIT_TIMEOUT";
      stopActiveCampaign("Campaign stopped because WhatsApp Web did not finish loading.");
      client = null;
      whatsappReady = false;
      connectInProgress = false;
      lastQrDataUrl = null;
      lastPairingCode = null;
      lastPairingPhone = null;
      await cleanupOrphanSessionBrowsers();
    }
    if (/Failed to launch the browser process/i.test(err.message) && launchAttempt < 2) {
      io.emit("log", "Chromium did not launch cleanly. Retrying once...");
      await cleanupStaleSessionLocks();
      await delay(2500);
      return initClientUnlocked(launchAttempt + 1);
    }
  }
}

async function initClient() {
  if (clientInitPromise) {
    io.emit("log", "WhatsApp connection is already starting...");
    return clientInitPromise;
  }

  const pending = initClientUnlocked();
  clientInitPromise = pending;
  try {
    return await pending;
  } finally {
    if (clientInitPromise === pending) clientInitPromise = null;
  }
}

async function requestPairingCode(phoneNumber) {
  const normalizedPhone = normalizeNumber(phoneNumber);
  if (!normalizedPhone || normalizedPhone.length < 8) {
    throw new Error("Enter a valid phone number in international format.");
  }

  lastPairingPhone = normalizedPhone;
  lastPairingCode = null;
  lastQrDataUrl = null;

  if (!client) {
    await initClient();
  }

  if (!client) {
    throw new Error("WhatsApp client is not available.");
  }

  io.emit("log", `Requesting pairing code for ${normalizedPhone}...`);
  const code = await client.requestPairingCode(normalizedPhone, true, 180000);
  lastPairingCode = code;
  io.emit("pairing-code", { code, phone: normalizedPhone });
  return code;
}

async function logoutClient(reason) {
  if (!client) return;
  io.emit("log", reason);
  const old = client;
  client = null;
  whatsappReady = false;
  connectInProgress = false;
  lastQrDataUrl = null;
  lastPairingCode = null;
  lastPairingPhone = null;
  io.emit("not-ready");
  try {
    await old.logout();
  } catch (err) {
    // fall through to destroy even if logout fails (e.g. already logged out)
  }
  try {
    await old.destroy();
  } catch (err) {
    // ignore
  }
}

async function resetAndInitClient(reason) {
  if (clientResetPromise) {
    io.emit("log", "A WhatsApp reconnection is already in progress...");
    return clientResetPromise;
  }

  const pending = (async () => {
    await logoutClient(reason);
    if (sessionInitTimedOut && fs.existsSync(WWEBJS_SESSION_DIR)) {
      await cleanupOrphanSessionBrowsers();
      fs.rmSync(WWEBJS_SESSION_DIR, { recursive: true, force: true });
      sessionInitTimedOut = false;
      console.log("[whatsapp] removed unresponsive saved session; starting fresh pairing");
      io.emit("log", "Saved WhatsApp session was unresponsive. Starting a fresh QR code...");
    }
    return initClient();
  })();
  clientResetPromise = pending;
  try {
    return await pending;
  } finally {
    if (clientResetPromise === pending) clientResetPromise = null;
  }
}

async function resetAndRequestPairingCode(phoneNumber) {
  if (clientResetPromise) {
    throw new Error("A WhatsApp reconnection is already in progress.");
  }

  const pending = (async () => {
    await logoutClient("Ending current session so you can generate a new pairing code...");
    return requestPairingCode(phoneNumber);
  })();
  clientResetPromise = pending;
  try {
    return await pending;
  } finally {
    if (clientResetPromise === pending) clientResetPromise = null;
  }
}

async function forceFreshReconnect() {
  if (forcedReconnectPromise) return forcedReconnectPromise;

  const pending = (async () => {
    io.emit("log", "Cancelling the stuck WhatsApp session and starting fresh...");
    const oldClient = client;
    client = null;
    clientInitPromise = null;
    clientResetPromise = null;
    whatsappReady = false;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
    io.emit("not-ready");

    if (oldClient) {
      await Promise.race([oldClient.destroy().catch(() => {}), delay(5000)]);
    }
    await cleanupOrphanSessionBrowsers();
    fs.rmSync(WWEBJS_SESSION_DIR, { recursive: true, force: true });
    fs.writeFileSync(SESSION_RECOVERY_MARKER, new Date().toISOString());
    sessionInitTimedOut = false;
    return initClient();
  })();
  forcedReconnectPromise = pending;
  try {
    return await pending;
  } finally {
    if (forcedReconnectPromise === pending) forcedReconnectPromise = null;
  }
}

async function recoverBrowserSession(cause) {
  if (browserRecoveryPromise) return browserRecoveryPromise;
  if (sending) {
    markWhatsappUnavailable(cause);
    const err = new Error(`WhatsApp browser became unavailable (${cause}). Reconnect WhatsApp before sending again.`);
    err.code = "WA_CLIENT_UNAVAILABLE";
    throw err;
  }

  const pending = (async () => {
    io.emit("log", `WhatsApp browser became unavailable (${cause}). Reconnecting automatically...`);
    const oldClient = client;
    client = null;
    whatsappReady = false;
    connectInProgress = true;
    io.emit("not-ready");

    if (oldClient) {
      await Promise.race([oldClient.destroy().catch(() => {}), delay(5000)]);
    }
    await cleanupOrphanSessionBrowsers();
    await cleanupStaleSessionLocks();
    await initClient();

    if (!client || !whatsappReady) {
      const err = new Error("WhatsApp could not reconnect automatically. Reconnect it before sending again.");
      err.code = "WA_CLIENT_UNAVAILABLE";
      throw err;
    }
    io.emit("log", "WhatsApp browser recovered. Resuming the campaign...");
    return client;
  })();

  browserRecoveryPromise = pending;
  try {
    return await pending;
  } finally {
    if (browserRecoveryPromise === pending) browserRecoveryPromise = null;
  }
}

async function getHealthyClient() {
  const activeClient = client;
  if (!activeClient || !whatsappReady) {
    const err = new Error("WhatsApp is not connected.");
    err.code = "WA_CLIENT_UNAVAILABLE";
    throw err;
  }

  try {
    if (!activeClient.pupPage || activeClient.pupPage.isClosed()) {
      throw new Error("WhatsApp browser page is closed");
    }
    const healthTimeoutMs = Number(process.env.WHATSAPP_HEALTH_TIMEOUT_MS) || 15000;
    const state = await withTimeout(
      activeClient.getState(),
      healthTimeoutMs,
      `WhatsApp did not respond to the connection check within ${Math.round(healthTimeoutMs / 1000)} seconds.`,
    );
    if (state !== "CONNECTED") {
      throw new Error(`WhatsApp browser state is ${state || "unknown"}`);
    }
    return activeClient;
  } catch (err) {
    return recoverBrowserSession(err.message);
  }
}

async function sendToContact(phone, body, imageMedia) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const activeClient = await getHealthyClient();
      const recipientIds = await resolveRecipientIds(activeClient, phone);
      if (!recipientIds.length) return false;

      io.emit("log", `Sending -> ${phone}...`);
      console.log(`[send] ${phone} candidates: ${describeRecipientIds(recipientIds)}`);
      const sendTimeoutMs = Number(process.env.WHATSAPP_SEND_TIMEOUT_MS) || 60000;
      let lastError = null;

      for (const chatId of recipientIds) {
        try {
          if (imageMedia) {
            const mediaAttempts = [
              { label: "image", options: { caption: body, linkPreview: false, sendSeen: false } },
              { label: "image document", options: { caption: body, linkPreview: false, sendSeen: false, sendMediaAsDocument: true } },
            ];

            for (const mediaAttempt of mediaAttempts) {
              const imageMessage = await sendMessageAndVerifyCreated(
                activeClient,
                chatId,
                imageMedia,
                mediaAttempt.options,
                body,
                sendTimeoutMs,
                `WhatsApp did not create the ${mediaAttempt.label} message within ${Math.round(sendTimeoutMs / 1000)} seconds.`,
              );
              if (imageMessage) {
                await waitForServerAck(activeClient, imageMessage);
                return true;
              }
              lastError = new Error(`WhatsApp did not create a ${mediaAttempt.label} message for ${chatId}.`);
              io.emit("log", `${mediaAttempt.label[0].toUpperCase()}${mediaAttempt.label.slice(1)} send was not created for ${phone}; trying next media path...`);
            }

            io.emit("log", `Image send was not created for ${phone}; trying another WhatsApp chat id...`);
            continue;
          }

          const textMessage = await sendMessageAndVerifyCreated(
            activeClient,
            chatId,
            body,
            { linkPreview: false, sendSeen: false },
            body,
            sendTimeoutMs,
            `WhatsApp did not create the message within ${Math.round(sendTimeoutMs / 1000)} seconds.`,
          );
          if (textMessage) {
            await waitForServerAck(activeClient, textMessage);
            return true;
          }

          lastError = new Error(`WhatsApp did not create an outgoing message for ${chatId}.`);
        } catch (err) {
          if (err.code === "WA_SEND_TIMEOUT" || isRecoverableBrowserError(err)) throw err;
          lastError = err;
        }
      }

      if (!imageMedia) {
        io.emit("log", `WhatsApp API did not create a message for ${phone}; trying compose fallback...`);
        const fallbackMessage = await sendViaPhoneComposeFallback(activeClient, phone, body, sendTimeoutMs);
        if (fallbackMessage === false) return false;
        if (fallbackMessage) {
          await waitForServerAck(activeClient, fallbackMessage);
          return true;
        }
      }

      const err = lastError || new Error("WhatsApp did not create an outgoing message.");
      err.code = "WA_MESSAGE_NOT_CREATED";
      throw err;
    } catch (err) {
      if (!isRecoverableBrowserError(err) || attempt === 2) throw err;
      await recoverBrowserSession(err.message);
      io.emit("log", `Retrying ${phone} after browser recovery...`);
    }
  }
  return false;
}

io.on("connection", (socket) => {
  if (whatsappReady) socket.emit("ready");
  socket.emit("sending-state", sending);
  socket.emit("campaign-state", { sending, paused: campaignPaused });
  socket.emit("campaign-queue", sending ? campaignQueueState : queueSnapshot(listQueuedContacts()));
  if (lastQrDataUrl) socket.emit("qr", lastQrDataUrl);
  if (lastPairingCode) socket.emit("pairing-code", { code: lastPairingCode, phone: lastPairingPhone });

  socket.on("connect-whatsapp", async () => {
    resetAndInitClient("Ending current session so you can scan a new QR code...").catch((err) => {
      io.emit("log", `Failed to initialize WhatsApp client: ${err.message}`);
      connectInProgress = false;
    });
  });

  socket.on("cancel-reconnect-whatsapp", () => {
    forceFreshReconnect().catch((err) => {
      connectInProgress = false;
      io.emit("log", `Failed to reset WhatsApp session: ${err.message}`);
    });
  });

  socket.on("request-pairing-code", async ({ phoneNumber }) => {
    try {
      const code = await resetAndRequestPairingCode(phoneNumber);
      socket.emit("pairing-code", { code, phone: lastPairingPhone });
    } catch (err) {
      connectInProgress = false;
      io.emit("log", `Failed to get pairing code: ${err.message}`);
    }
  });

  socket.on("logout-whatsapp", async () => {
    if (!client) {
      io.emit("log", "Not connected.");
      return;
    }
    await logoutClient("Logging out of WhatsApp...");
    io.emit("log", "Logged out.");
  });

  socket.on("stop-campaign", () => {
    if (!sending) {
      socket.emit("log", "No campaign is currently running.");
      return;
    }
    if (stopCampaignRequested) return;
    stopCampaignRequested = true;
    campaignPaused = false;
    io.emit("log", "Cancel requested. Finishing the current message, then the campaign will stop...");
    if (cancelCampaignDelay) cancelCampaignDelay();
    if (resumeCampaignWait) resumeCampaignWait();
    emitCampaignState();
  });

  socket.on("pause-campaign", () => {
    if (!sending || campaignPaused) return;
    campaignPaused = true;
    if (cancelCampaignDelay) cancelCampaignDelay();
    io.emit("log", `Campaign paused at ${formatCampaignTime()}. No new messages will start until you resume.`);
    emitCampaignState();
  });

  socket.on("resume-campaign", () => {
    if (!sending || !campaignPaused) return;
    campaignPaused = false;
    if (resumeCampaignWait) resumeCampaignWait();
    io.emit("log", `Campaign resumed at ${formatCampaignTime()}.`);
    emitCampaignState();
  });

  // timings: msgMinDelay/msgMaxDelay = seconds between individual messages
  //          batchSize = messages per batch
  //          batchMinDelay/batchMaxDelay = seconds to rest between batches
  socket.on("start-send", async ({ msgMinDelay, msgMaxDelay, batchSize, batchMinDelay, batchMaxDelay, dryRun, maxContacts }) => {
    if (sending) {
      socket.emit("log", "A send is already in progress.");
      return;
    }
    if (!dryRun && !whatsappReady) {
      socket.emit("log", "WhatsApp is not connected yet.");
      return;
    }
    if (!dryRun) {
      try {
        socket.emit("log", "Checking WhatsApp connection before starting...");
        await getHealthyClient();
      } catch (err) {
        socket.emit("log", `[ERROR] ${err.message}`);
        return;
      }
    }

    sending = true;
    const campaignStartedAt = new Date();
    const timing = sanitizeCampaignTiming({ msgMinDelay, msgMaxDelay, batchSize, batchMinDelay, batchMaxDelay });
    stopCampaignRequested = false;
    campaignPaused = false;
    io.emit("sending-state", true);
    emitCampaignState();

    try {
    const contacts = loadCsv(CONTACTS_FILE);
    const optouts = new Set(loadCsv(OPTOUT_FILE).map((r) => normalizeNumber(r.phone)));
    const template = fs.existsSync(MESSAGE_FILE) ? fs.readFileSync(MESSAGE_FILE, "utf8").trim() : "";
    if (!template) {
      socket.emit("log", "[ERROR] Save a message template before starting the campaign.");
      return;
    }
    const log = loadLog();
    const imageMeta = loadImageMeta();
    const imageMedia = imageMeta
      ? new MessageMedia(imageMeta.mimeType, fs.readFileSync(IMAGE_FILE).toString("base64"), imageMeta.name)
      : null;

    const allPending = listQueuedContacts(contacts, log, optouts);
    const sendLimit = Math.round(clampNumber(maxContacts, allPending.length, 1, allPending.length));
    const pending = allPending.slice(0, sendLimit);
    if (!pending.length) {
      emitCampaignQueue([], 0, false, dryRun);
      io.emit("log", "No pending contacts to send.");
      return;
    }

    const size = timing.batchSize;
    const limitText = pending.length < allPending.length ? `, limited to ${pending.length} of ${allPending.length} pending` : "";
    emitCampaignQueue(pending, 0, true, dryRun);
    io.emit("log", `Campaign started at ${formatCampaignTime(campaignStartedAt)}: ${pending.length} contact(s)${limitText}, batch size ${size}${dryRun ? " (dry run)" : ""}.`);

    let abortReason = null;
    let finalQueueIndex = pending.length;
    for (const [i, contact] of pending.entries()) {
      emitCampaignQueue(pending, i, true, dryRun);
      await waitWhileCampaignPaused();
      if (stopCampaignRequested) {
        abortReason = "Campaign stopped by user. Remaining contacts are ready for the next run.";
        finalQueueIndex = i;
        break;
      }
      const phone = normalizeNumber(contact.phone);
      const body = renderTemplate(template, contact);
      io.emit("contact-status", { phone, status: "sending" });

      if (dryRun) {
        io.emit("log", `[DRY RUN] To ${phone}${imageMedia ? ` with ${imageMeta.name}` : ""}: ${body}`);
        io.emit("contact-status", { phone, status: "dry_run" });
      } else {
        try {
          const sent = await sendToContact(phone, body, imageMedia);
          if (!sent) {
            io.emit("log", `[SKIP] ${phone} is not on WhatsApp.`);
            log[phone] = { status: "not_registered", at: new Date().toISOString() };
            saveLog(log);
            io.emit("contact-status", { phone, status: "not_registered" });
          } else {
            const sentAt = new Date();
            io.emit("log", `[SENT] -> ${phone} at ${formatCampaignTime(sentAt)}`);
            log[phone] = { status: "sent", at: sentAt.toISOString() };
            saveLog(log);
            io.emit("contact-status", { phone, status: "sent" });
          }
        } catch (err) {
          io.emit("log", `[ERROR] ${phone}: ${err.message}`);
          log[phone] = { status: "error", error: err.message, at: new Date().toISOString() };
          saveLog(log);
          io.emit("contact-status", { phone, status: "error" });
          if (["WA_CLIENT_UNAVAILABLE", "WA_SEND_TIMEOUT"].includes(err.code) || isRecoverableBrowserError(err)) {
            abortReason = "The WhatsApp browser could not complete the current send safely. Campaign stopped to protect the remaining contacts.";
            finalQueueIndex = i + 1;
            break;
          }
        }
      }
      emitCampaignQueue(pending, i + 1, true, dryRun);

      const isLast = i === pending.length - 1;
      const endOfBatch = (i + 1) % size === 0;

      await waitWhileCampaignPaused();
      if (stopCampaignRequested) {
        abortReason = "Campaign stopped by user. Remaining contacts are ready for the next run.";
        finalQueueIndex = i + 1;
        break;
      }

      if (!isLast) {
        if (endOfBatch) {
          const delaySec = timing.batchMinDelay + Math.random() * (timing.batchMaxDelay - timing.batchMinDelay);
          const resumeAt = new Date(Date.now() + delaySec * 1000);
          io.emit("log", `Batch of ${size} done. Next batch at ${formatCampaignTime(resumeAt)} (in ${delaySec.toFixed(1)}s).`);
          await waitForCampaignDelay(delaySec * 1000);
        } else {
          const delaySec = timing.msgMinDelay + Math.random() * (timing.msgMaxDelay - timing.msgMinDelay);
          const nextAt = new Date(Date.now() + delaySec * 1000);
          io.emit("log", `Next message at ${formatCampaignTime(nextAt)} (in ${delaySec.toFixed(1)}s).`);
          await waitForCampaignDelay(delaySec * 1000);
        }
      }
    }

    const campaignEndedAt = new Date();
    const durationSec = Math.round((campaignEndedAt - campaignStartedAt) / 1000);
    emitCampaignQueue(pending, finalQueueIndex, false, dryRun);
    io.emit("log", abortReason || "Campaign completed.");
    io.emit("log", `Campaign ended at ${formatCampaignTime(campaignEndedAt)}. Total duration: ${durationSec}s.`);
    } catch (err) {
      io.emit("log", `[ERROR] Campaign failed: ${err.message}`);
      emitCampaignQueue([], 0, false, false);
    } finally {
    sending = false;
    stopCampaignRequested = false;
    campaignPaused = false;
    cancelCampaignDelay = null;
    if (resumeCampaignWait) resumeCampaignWait();
    resumeCampaignWait = null;
    io.emit("sending-state", false);
    emitCampaignState();
    }
  });
});

const PORT = process.env.PORT || 3000;

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "Image must be 10 MB or smaller." });
  }
  next(err);
});

async function startWhatsAppOnBoot() {
  if (!fs.existsSync(WWEBJS_SESSION_DIR)) return;

  console.log("[whatsapp] restoring saved session...");
  await initClient();
  if (sessionInitTimedOut) {
    await resetAndInitClient("Saved WhatsApp session did not respond. Recovering automatically...");
  }
}

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  startWhatsAppOnBoot().catch((err) => console.log(`[whatsapp] startup failed: ${err.message}`));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}; closing WhatsApp browser cleanly`);

  const activeClient = client;
  client = null;
  if (activeClient) {
    try {
      await activeClient.destroy();
    } catch (err) {
      console.log(`[whatsapp] shutdown destroy failed: ${err.message}`);
    }
  }

  await cleanupOrphanSessionBrowsers();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
