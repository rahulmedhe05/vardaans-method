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
const CHATBOT_FILE = path.join(DATA_DIR, "chatbot.json");
const CHATBOT_ACTIVITY_FILE = path.join(DATA_DIR, "chatbot-activity.json");
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
  return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
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

const DEFAULT_CHATBOT_CONFIG = {
  version: 2,
  enabled: false,
  triggers: ["hi", "hello", "hey", "menu"],
  startNodeId: "welcome",
  nodes: [
    {
      id: "welcome",
      name: "Welcome & Catalog",
      message: "Hi! Welcome to Vardaan's Method. Tap a service below:",
      actions: [
        { id: "seo", type: "reply", label: "SEO Services", nextNodeId: "seo" },
        { id: "marketing", type: "reply", label: "Digital Marketing", nextNodeId: "marketing" },
        { id: "website", type: "reply", label: "Website Development", nextNodeId: "website" },
      ],
    },
    {
      id: "seo",
      name: "SEO Services",
      message: "We help businesses improve Google rankings and organic traffic. Open our website or return to services.",
      actions: [
        { id: "seo-url", type: "url", label: "Visit Website", url: "https://goplnr.com" },
        { id: "seo-back", type: "reply", label: "Back to Services", nextNodeId: "welcome" },
      ],
    },
    {
      id: "marketing",
      name: "Digital Marketing",
      message: "We provide strategy, content, advertising, and lead-generation support.",
      actions: [
        { id: "marketing-url", type: "url", label: "Visit Website", url: "https://goplnr.com" },
        { id: "marketing-back", type: "reply", label: "Back to Services", nextNodeId: "welcome" },
      ],
    },
    {
      id: "website",
      name: "Website Development",
      message: "We build fast, mobile-friendly business websites and landing pages.",
      actions: [
        { id: "website-url", type: "url", label: "Visit Website", url: "https://goplnr.com" },
        { id: "website-back", type: "reply", label: "Back to Services", nextNodeId: "welcome" },
      ],
    },
  ],
  fallbackMessage: "Please tap one of the available buttons, or type menu to restart.",
};

function cloneDefaultChatbotConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CHATBOT_CONFIG));
}

function normalizeFlowId(value, fallback) {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || fallback;
}

function migrateLegacyChatbotConfig(input) {
  if (Array.isArray(input.nodes)) return input;
  const legacyOptions = (Array.isArray(input.options) ? input.options : [])
    .map((option, index) => ({
      id: normalizeFlowId(option.key, `option-${index + 1}`),
      title: String(option.title || `Option ${index + 1}`).trim(),
      response: String(option.response || "").trim(),
    }))
    .filter((option) => option.response)
    .slice(0, 10);
  if (!legacyOptions.length) return { ...cloneDefaultChatbotConfig(), enabled: Boolean(input.enabled) };

  return {
    ...input,
    version: 2,
    startNodeId: "welcome",
    nodes: [
      {
        id: "welcome",
        name: "Welcome & Catalog",
        message: String(input.welcomeMessage || DEFAULT_CHATBOT_CONFIG.nodes[0].message),
        actions: legacyOptions.slice(0, 3).map((option) => ({
          id: `open-${option.id}`,
          type: "reply",
          label: option.title,
          nextNodeId: option.id,
        })),
      },
      ...legacyOptions.map((option) => ({
        id: option.id,
        name: option.title,
        message: option.response,
        actions: [{ id: `back-${option.id}`, type: "reply", label: "Back to Services", nextNodeId: "welcome" }],
      })),
    ],
  };
}

function sanitizeChatbotConfig(input = {}) {
  const source = migrateLegacyChatbotConfig(input);
  const triggers = (Array.isArray(source.triggers) ? source.triggers : [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20)
    .map((value) => value.slice(0, 40));
  const usedNodeIds = new Set();
  const rawNodes = (Array.isArray(source.nodes) ? source.nodes : []).slice(0, 20);
  const nodeShells = rawNodes.map((node, index) => {
    let id = normalizeFlowId(node?.id, `step-${index + 1}`);
    while (usedNodeIds.has(id)) id = `${id}-${index + 1}`.slice(0, 48);
    usedNodeIds.add(id);
    return { raw: node || {}, id };
  });
  const validNodeIds = new Set(nodeShells.map((node) => node.id));
  const nodes = nodeShells.map(({ raw, id }, nodeIndex) => {
    let replyCount = 0;
    const usedActionIds = new Set();
    const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((action, actionIndex) => {
      const type = action?.type === "url" ? "url" : "reply";
      const label = String(action?.label || "").trim().slice(0, type === "reply" ? 20 : 40);
      let actionId = normalizeFlowId(action?.id, `action-${actionIndex + 1}`);
      while (usedActionIds.has(actionId)) actionId = `${actionId}-${actionIndex + 1}`.slice(0, 48);
      usedActionIds.add(actionId);
      if (!label) return null;
      if (type === "url") {
        try {
          const url = new URL(String(action.url || "").trim());
          if (!["http:", "https:"].includes(url.protocol)) return null;
          return { id: actionId, type, label, url: url.toString().slice(0, 1000) };
        } catch (err) {
          return null;
        }
      }
      if (replyCount >= 3) return null;
      const nextNodeId = normalizeFlowId(action?.nextNodeId, "");
      if (!validNodeIds.has(nextNodeId)) return null;
      replyCount += 1;
      return { id: actionId, type, label, nextNodeId };
    }).filter(Boolean).slice(0, 6);
    return {
      id,
      name: String(raw.name || `Step ${nodeIndex + 1}`).trim().slice(0, 80),
      message: String(raw.message || "").trim().slice(0, 4000) || `Step ${nodeIndex + 1}`,
      actions,
    };
  });

  if (!nodes.length) return cloneDefaultChatbotConfig();
  const requestedStart = normalizeFlowId(source.startNodeId, nodes[0].id);

  return {
    version: 2,
    enabled: Boolean(source.enabled),
    triggers: triggers.length ? [...new Set(triggers)] : DEFAULT_CHATBOT_CONFIG.triggers,
    startNodeId: validNodeIds.has(requestedStart) ? requestedStart : nodes[0].id,
    nodes,
    fallbackMessage: String(source.fallbackMessage || "").trim().slice(0, 4000) || DEFAULT_CHATBOT_CONFIG.fallbackMessage,
  };
}

function loadChatbotConfig() {
  if (!fs.existsSync(CHATBOT_FILE)) return cloneDefaultChatbotConfig();
  try {
    return sanitizeChatbotConfig(JSON.parse(fs.readFileSync(CHATBOT_FILE, "utf8")));
  } catch (err) {
    console.log(`[chatbot] failed to load config: ${err.message}`);
    return cloneDefaultChatbotConfig();
  }
}

function saveChatbotConfig(config) {
  fs.writeFileSync(CHATBOT_FILE, JSON.stringify(config, null, 2));
}

function loadChatbotActivity() {
  if (!fs.existsSync(CHATBOT_ACTIVITY_FILE)) return [];
  try {
    const activity = JSON.parse(fs.readFileSync(CHATBOT_ACTIVITY_FILE, "utf8"));
    return Array.isArray(activity) ? activity : [];
  } catch (err) {
    return [];
  }
}

function recordChatbotActivity(entry) {
  const activity = [...loadChatbotActivity(), { ...entry, at: new Date().toISOString() }].slice(-100);
  fs.writeFileSync(CHATBOT_ACTIVITY_FILE, JSON.stringify(activity, null, 2));
  io.emit("chatbot-activity", activity[activity.length - 1]);
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

  const numberId = await targetClient.getNumberId(phone);
  if (!numberId?._serialized) return [];
  candidateIds.push(numberId._serialized);

  // WhatsApp now routes many users through a LID. Resolve it before opening
  // the chat so sendMessage does not fail in findOrCreateLatestChat.
  if (typeof targetClient.getContactLidAndPhone === "function") {
    try {
      const [resolved] = await targetClient.getContactLidAndPhone([phoneId]);
      if (resolved?.pn) candidateIds.push(resolved.pn);
      if (resolved?.lid) candidateIds.push(resolved.lid);
    } catch (err) {
      if (isRecoverableBrowserError(err)) throw err;
      console.log(`[recipient] LID lookup failed for ${phone}: ${err.message}`);
    }
  }

  candidateIds.push(phoneId);
  return [...new Set(candidateIds.filter(Boolean))];
}

function renderTemplate(template, row) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => row[key] ?? "");
}

function writeContactsCsv(rows) {
  const header = "name,phone";
  const lines = rows.map((r) => `${(r.name || "").replace(/,/g, " ")},${normalizeNumber(r.phone)}`);
  fs.writeFileSync(CONTACTS_FILE, [header, ...lines].join("\n") + "\n");
}

// ---- REST API ----

app.get("/api/state", (req, res) => {
  const contacts = loadCsv(CONTACTS_FILE);
  const optouts = new Set(loadCsv(OPTOUT_FILE).map((r) => normalizeNumber(r.phone)));
  const log = loadLog();
  const message = fs.existsSync(MESSAGE_FILE) ? fs.readFileSync(MESSAGE_FILE, "utf8") : "";
  const image = loadImageMeta();

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
  res.json({ config: loadChatbotConfig(), activity: loadChatbotActivity().slice(-30) });
});

app.put("/api/chatbot", (req, res) => {
  const config = sanitizeChatbotConfig(req.body);
  saveChatbotConfig(config);
  if (!config.enabled) chatbotSessions.clear();
  io.emit("chatbot-config", config);
  res.json({ ok: true, config });
});

app.delete("/api/chatbot/activity", (req, res) => {
  if (fs.existsSync(CHATBOT_ACTIVITY_FILE)) fs.unlinkSync(CHATBOT_ACTIVITY_FILE);
  io.emit("chatbot-activity-cleared");
  res.json({ ok: true });
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
const chatbotSessions = new Map();
let chatbotReplyChain = Promise.resolve();

function getChatbotNode(config, nodeId) {
  return config.nodes.find((node) => node.id === nodeId) || null;
}

function formatChatbotNode(node, includeReplyFallback = false) {
  const urlLines = node.actions
    .filter((action) => action.type === "url")
    .map((action) => `${action.label}: ${action.url}`);
  const replyLines = includeReplyFallback
    ? node.actions.filter((action) => action.type === "reply").map((action, index) => `${index + 1}. ${action.label}`)
    : [];
  return [node.message, ...urlLines, ...replyLines].filter(Boolean).join("\n\n");
}

async function sendChatbotNode(activeClient, to, node) {
  const fallbackBody = formatChatbotNode(node, true);
  await activeClient.sendMessage(to, fallbackBody, { linkPreview: true });
  return { response: fallbackBody, interactive: false, interaction: "text" };
}

async function handleChatbotMessage(message) {
  const config = loadChatbotConfig();
  if (!config.enabled || !whatsappReady || !client) return;
  if (message.fromMe || !message.from || typeof message.body !== "string") return;
  if (/@g\.us$|status@broadcast$|@newsletter$/.test(message.from)) return;

  const incoming = message.body.trim();
  if (!incoming) return;
  const normalized = incoming.toLowerCase().replace(/\s+/g, " ");
  const selection = normalized.replace(/^[\s.,!?]+|[\s.,!?]+$/g, "");
  const now = Date.now();
  const sessionMaxAgeMs = 30 * 60 * 1000;
  const session = chatbotSessions.get(message.from);
  const sessionActive = session && now - session.at < sessionMaxAgeMs;
  const isTrigger = config.triggers.includes(selection);

  let targetNode = null;
  let type = "flow";
  if (isTrigger) {
    targetNode = getChatbotNode(config, config.startNodeId);
    type = "start";
  } else if (sessionActive) {
    const currentNode = getChatbotNode(config, session.nodeId);
    const replyActions = currentNode?.actions.filter((action) => action.type === "reply") || [];
    const selectedButtonId = String(message.selectedButtonId || "");
    const action = replyActions.find((item, index) =>
      selectedButtonId === `flow:${currentNode.id}:${item.id}` ||
      item.label.toLowerCase() === selection ||
      String(index + 1) === selection
    );
    if (!action) {
      try {
        const activeClient = await getHealthyClient();
        await activeClient.sendMessage(message.from, config.fallbackMessage);
        chatbotSessions.set(message.from, { nodeId: session.nodeId, at: now });
        recordChatbotActivity({ from: message.from, incoming, response: config.fallbackMessage, type: "fallback", status: "sent" });
      } catch (err) {
        recordChatbotActivity({ from: message.from, incoming, response: err.message, type: "fallback", status: "error" });
      }
      return;
    }
    targetNode = getChatbotNode(config, action.nextNodeId);
    type = "button";
  } else {
    return;
  }

  if (!targetNode) return;

  try {
    const activeClient = await getHealthyClient();
    const result = await sendChatbotNode(activeClient, message.from, targetNode);
    const hasNextStep = targetNode.actions.some((action) => action.type === "reply");
    if (hasNextStep) chatbotSessions.set(message.from, { nodeId: targetNode.id, at: now });
    else chatbotSessions.delete(message.from);
    recordChatbotActivity({ from: message.from, incoming, response: result.response, type, status: "sent", interactive: result.interactive });
  } catch (err) {
    console.log(`[chatbot] reply failed for ${message.from}: ${err.message}`);
    recordChatbotActivity({ from: message.from, incoming, response: err.message, type, status: "error" });
  }
}

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

  newClient.on("message", (message) => {
    if (client !== newClient) return;
    chatbotReplyChain = chatbotReplyChain
      .then(() => handleChatbotMessage(message))
      .catch((err) => console.log(`[chatbot] queue error: ${err.message}`));
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
    const state = await activeClient.getState();
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
      const sendTimeoutMs = Number(process.env.WHATSAPP_SEND_TIMEOUT_MS) || 60000;
      let lastError = null;

      for (const chatId of recipientIds) {
        try {
          if (imageMedia) {
            const mediaAttempts = [
              { label: "image", options: { caption: body } },
              { label: "image document", options: { caption: body, sendMediaAsDocument: true } },
            ];

            for (const mediaAttempt of mediaAttempts) {
              const imageMessage = await withTimeout(
                activeClient.sendMessage(chatId, imageMedia, mediaAttempt.options),
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

          const textMessage = await withTimeout(
            activeClient.sendMessage(chatId, body),
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
    const template = fs.readFileSync(MESSAGE_FILE, "utf8").trim();
    const log = loadLog();
    const imageMeta = loadImageMeta();
    const imageMedia = imageMeta
      ? new MessageMedia(imageMeta.mimeType, fs.readFileSync(IMAGE_FILE).toString("base64"), imageMeta.name)
      : null;

    const allPending = contacts.filter((c) => {
      const phone = normalizeNumber(c.phone);
      if (optouts.has(phone)) return false;
      if (["sent", "not_registered", "error"].includes(log[phone]?.status)) return false;
      return true;
    });
    const sendLimit = Math.round(clampNumber(maxContacts, allPending.length, 1, allPending.length));
    const pending = allPending.slice(0, sendLimit);

    const size = timing.batchSize;
    const limitText = pending.length < allPending.length ? `, limited to ${pending.length} of ${allPending.length} pending` : "";
    io.emit("log", `Campaign started at ${formatCampaignTime(campaignStartedAt)}: ${pending.length} contact(s)${limitText}, batch size ${size}${dryRun ? " (dry run)" : ""}.`);

    let abortReason = null;
    for (const [i, contact] of pending.entries()) {
      await waitWhileCampaignPaused();
      if (stopCampaignRequested) {
        abortReason = "Campaign stopped by user. Remaining contacts are ready for the next run.";
        break;
      }
      const phone = normalizeNumber(contact.phone);
      const body = renderTemplate(template, contact);

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
          if (["WA_CLIENT_UNAVAILABLE", "WA_SEND_TIMEOUT", "WA_MESSAGE_NOT_CREATED"].includes(err.code) || isRecoverableBrowserError(err)) {
            abortReason = "The WhatsApp browser could not complete the current send safely. Campaign stopped to protect the remaining contacts.";
            break;
          }
        }
      }

      const isLast = i === pending.length - 1;
      const endOfBatch = (i + 1) % size === 0;

      await waitWhileCampaignPaused();
      if (stopCampaignRequested) {
        abortReason = "Campaign stopped by user. Remaining contacts are ready for the next run.";
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
    io.emit("log", abortReason || "Campaign completed.");
    io.emit("log", `Campaign ended at ${formatCampaignTime(campaignEndedAt)}. Total duration: ${durationSec}s.`);
    } catch (err) {
      io.emit("log", `[ERROR] Campaign failed: ${err.message}`);
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
