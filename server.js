const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const express = require("express");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { parse } = require("csv-parse/sync");
const { Client, LocalAuth } = require("whatsapp-web.js");

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
const WWEBJS_SESSION_DIR = path.join(AUTH_DIR, "session");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });
console.log(`[storage] using data dir: ${DATA_DIR}`);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage() });

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

function normalizeNumber(raw) {
  const digits = String(raw).replace(/[^\d]/g, "");
  const defaultCountryCode = String(process.env.DEFAULT_COUNTRY_CODE || "91").replace(/[^\d]/g, "");
  return digits.length === 10 && defaultCountryCode ? `${defaultCountryCode}${digits}` : digits;
}

async function resolveRecipientId(phone) {
  const phoneId = `${phone}@c.us`;

  // WhatsApp now routes many users through a LID. Resolve it before opening
  // the chat so sendMessage does not fail in findOrCreateLatestChat.
  if (typeof client.getContactLidAndPhone === "function") {
    try {
      const [resolved] = await client.getContactLidAndPhone([phoneId]);
      if (resolved?.lid) return resolved.lid;
      if (resolved?.pn) return resolved.pn;
    } catch (err) {
      console.log(`[recipient] LID lookup failed for ${phone}: ${err.message}`);
    }
  }

  const numberId = await client.getNumberId(phoneId);
  return numberId?._serialized || null;
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

// ---- WhatsApp client ----

let client = null;
let whatsappReady = false;
let sending = false;
let lastQrDataUrl = null;
let connectInProgress = false;
let lastPairingCode = null;
let lastPairingPhone = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function initClient() {
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

  const chromiumPath = findChromiumExecutable();
  io.emit("log", chromiumPath ? `Using Chromium at: ${chromiumPath}` : "No system Chromium found — using Puppeteer's bundled binary (may fail on this host).");
  console.log(`[chromium] platform=${process.platform} arch=${process.arch}`);
  console.log(`[chromium] session dir=${WWEBJS_SESSION_DIR}`);
  console.log(`[chromium] data dir=${DATA_DIR}`);

  client = new Client({
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
        "--single-process",
      ],
    },
  });

  client.on("qr", async (qr) => {
    const dataUrl = await QRCode.toDataURL(qr);
    lastQrDataUrl = dataUrl;
    lastPairingCode = null;
    lastPairingPhone = null;
    io.emit("qr", dataUrl);
    io.emit("log", "Scan the QR code with WhatsApp > Linked Devices.");
  });

  client.on("code", (code) => {
    lastPairingCode = code;
    io.emit("pairing-code", { code, phone: lastPairingPhone });
    io.emit("log", `Pairing code ready for ${lastPairingPhone || "phone number"}.`);
  });

  client.on("loading_screen", (percent) => {
    io.emit("log", `Loading WhatsApp Web... ${percent}%`);
  });

  client.on("ready", () => {
    whatsappReady = true;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
    io.emit("ready");
    io.emit("log", "WhatsApp connected.");
  });

  client.on("auth_failure", (msg) => {
    io.emit("log", `Authentication failed: ${msg}. Try connecting again.`);
    client = null;
    whatsappReady = false;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
  });

  client.on("disconnected", (reason) => {
    whatsappReady = false;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
    io.emit("log", `WhatsApp disconnected: ${reason}`);
    client = null;
  });

  try {
    await client.initialize();
  } catch (err) {
    io.emit("log", `Failed to start WhatsApp session: ${err.message}`);
    console.log(`[chromium] initialize failed stack: ${err.stack || err.message}`);
    client = null;
    whatsappReady = false;
    connectInProgress = false;
    lastQrDataUrl = null;
    lastPairingCode = null;
    lastPairingPhone = null;
    await cleanupOrphanSessionBrowsers();
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

io.on("connection", (socket) => {
  if (whatsappReady) socket.emit("ready");
  if (lastQrDataUrl) socket.emit("qr", lastQrDataUrl);
  if (lastPairingCode) socket.emit("pairing-code", { code: lastPairingCode, phone: lastPairingPhone });

  socket.on("connect-whatsapp", async () => {
    await logoutClient("Ending current session so you can scan a new QR code...");
    initClient().catch((err) => {
      io.emit("log", `Failed to initialize WhatsApp client: ${err.message}`);
      connectInProgress = false;
    });
  });

  socket.on("request-pairing-code", async ({ phoneNumber }) => {
    try {
      await logoutClient("Ending current session so you can generate a new pairing code...");
      const code = await requestPairingCode(phoneNumber);
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

  // timings: msgMinDelay/msgMaxDelay = seconds between individual messages
  //          batchSize = messages per batch
  //          batchMinDelay/batchMaxDelay = seconds to rest between batches
  socket.on("start-send", async ({ msgMinDelay, msgMaxDelay, batchSize, batchMinDelay, batchMaxDelay, dryRun }) => {
    if (sending) {
      socket.emit("log", "A send is already in progress.");
      return;
    }
    if (!dryRun && !whatsappReady) {
      socket.emit("log", "WhatsApp is not connected yet.");
      return;
    }

    sending = true;
    io.emit("sending-state", true);

    const contacts = loadCsv(CONTACTS_FILE);
    const optouts = new Set(loadCsv(OPTOUT_FILE).map((r) => normalizeNumber(r.phone)));
    const template = fs.readFileSync(MESSAGE_FILE, "utf8").trim();
    const log = loadLog();

    const pending = contacts.filter((c) => {
      const phone = normalizeNumber(c.phone);
      if (optouts.has(phone)) return false;
      if (log[phone]?.status === "sent") return false;
      return true;
    });

    const size = Math.max(1, Number(batchSize) || pending.length);
    io.emit("log", `Starting ${dryRun ? "dry run" : "send"}: ${pending.length} contact(s), batch size ${size}.`);

    for (const [i, contact] of pending.entries()) {
      const phone = normalizeNumber(contact.phone);
      const body = renderTemplate(template, contact);

      if (dryRun) {
        io.emit("log", `[DRY RUN] To ${phone}: ${body}`);
        io.emit("contact-status", { phone, status: "dry_run" });
      } else {
        try {
          const recipientId = await resolveRecipientId(phone);
          if (!recipientId) {
            io.emit("log", `[SKIP] ${phone} is not on WhatsApp.`);
            log[phone] = { status: "not_registered", at: new Date().toISOString() };
            saveLog(log);
            io.emit("contact-status", { phone, status: "not_registered" });
          } else {
            await client.sendMessage(recipientId, body);
            io.emit("log", `[SENT] -> ${phone}`);
            log[phone] = { status: "sent", at: new Date().toISOString() };
            saveLog(log);
            io.emit("contact-status", { phone, status: "sent" });
          }
        } catch (err) {
          io.emit("log", `[ERROR] ${phone}: ${err.message}`);
          log[phone] = { status: "error", error: err.message, at: new Date().toISOString() };
          saveLog(log);
          io.emit("contact-status", { phone, status: "error" });
        }
      }

      const isLast = i === pending.length - 1;
      const endOfBatch = (i + 1) % size === 0;

      if (!isLast) {
        if (endOfBatch) {
          const delaySec = Number(batchMinDelay) + Math.random() * (Number(batchMaxDelay) - Number(batchMinDelay));
          io.emit("log", `Batch of ${size} done. Resting ${delaySec.toFixed(1)}s before next batch...`);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        } else {
          const delaySec = Number(msgMinDelay) + Math.random() * (Number(msgMaxDelay) - Number(msgMinDelay));
          io.emit("log", `Waiting ${delaySec.toFixed(1)}s before next message...`);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        }
      }
    }

    io.emit("log", "Done.");
    sending = false;
    io.emit("sending-state", false);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
