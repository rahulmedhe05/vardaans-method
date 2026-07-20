// Bulk WhatsApp sender for your own opted-in business contacts.
// Usage: node send.js [--min=20] [--max=60] [--dry-run]

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const CONTACTS_FILE = path.join(__dirname, "contacts.csv");
const MESSAGE_FILE = path.join(__dirname, "message.txt");
const OPTOUT_FILE = path.join(__dirname, "optout.csv");
const LOG_FILE = path.join(__dirname, "sent-log.json");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const MIN_DELAY_SEC = Number(args.min ?? 20);
const MAX_DELAY_SEC = Number(args.max ?? 60);
const DRY_RUN = Boolean(args["dry-run"]);

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

function renderTemplate(template, row) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => row[key] ?? "");
}

function randomDelayMs() {
  const sec = MIN_DELAY_SEC + Math.random() * (MAX_DELAY_SEC - MIN_DELAY_SEC);
  return Math.round(sec * 1000);
}

function normalizeNumber(raw) {
  return raw.replace(/[^\d]/g, "");
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

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyMessageInChat(targetClient, chatId, sentMessage) {
  const sentId = getMessageId(sentMessage);
  if (!sentId) throw new Error("WhatsApp did not return a message id for verification.");

  const timeoutMs = Number(process.env.WHATSAPP_VERIFY_TIMEOUT_MS) || 30000;
  const intervalMs = 1500;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const chat = await targetClient.getChatById(chatId);
      const recentMessages = await chat.fetchMessages({ limit: 20, fromMe: true });
      const verified = recentMessages.some((message) => getMessageId(message) === sentId && message.fromMe);
      if (verified) return true;
    } catch (err) {
      lastError = err;
    }

    await delay(intervalMs);
  }

  throw new Error(`Sent message was not visible in WhatsApp chat history after ${Math.round(timeoutMs / 1000)} seconds${lastError ? ` (${lastError.message})` : ""}.`);
}

async function main() {
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

  console.log(`Loaded ${contacts.length} contacts, ${optouts.size} opted out, ${pending.length} to send.`);
  if (pending.length === 0) {
    console.log("Nothing to send. Exiting.");
    return;
  }

  if (DRY_RUN) {
    for (const c of pending) {
      console.log(`[DRY RUN] To ${c.phone}: ${renderTemplate(template, c)}`);
    }
    return;
  }

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true },
  });

  client.on("qr", (qr) => {
    console.log("Scan this QR code with WhatsApp (Linked Devices):");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    console.log("WhatsApp client ready. Starting send...");

    for (const [i, contact] of pending.entries()) {
      const phone = normalizeNumber(contact.phone);
      const chatId = `${phone}@c.us`;
      const body = renderTemplate(template, contact);

      try {
        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
          console.log(`[SKIP] ${phone} is not a WhatsApp user.`);
          log[phone] = { status: "not_registered", at: new Date().toISOString() };
          saveLog(log);
          continue;
        }

        const sentMessage = await client.sendMessage(chatId, body, { waitUntilMsgSent: true });
        if (!sentMessage) throw new Error("WhatsApp did not create an outgoing message.");
        await waitForServerAck(client, sentMessage);
        console.log(`[VERIFY] Checking WhatsApp chat before continuing -> ${phone}`);
        await verifyMessageInChat(client, chatId, sentMessage);
        console.log(`[SENT] (${i + 1}/${pending.length}) -> ${phone}`);
        log[phone] = { status: "sent", at: new Date().toISOString() };
        saveLog(log);
      } catch (err) {
        console.error(`[ERROR] ${phone}: ${err.message}`);
        log[phone] = { status: "error", error: err.message, at: new Date().toISOString() };
        saveLog(log);
      }

      if (i < pending.length - 1) {
        const delay = randomDelayMs();
        console.log(`Waiting ${(delay / 1000).toFixed(1)}s before next message...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    console.log("Done. See sent-log.json for results.");
    await client.destroy();
    process.exit(0);
  });

  client.initialize();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
