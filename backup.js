// bot.js
require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============== CONFIG ==============
const BOT_TOKEN = process.env.BOT_TOKEN || 'REPLACE_WITH_TOKEN_FOR_LOCAL_TESTING';
if (!BOT_TOKEN || BOT_TOKEN === 'REPLACE_WITH_TOKEN_FOR_LOCAL_TESTING') {
  console.error("ERROR: Provide a valid BOT_TOKEN in environment variable BOT_TOKEN");
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10); // default 60s

// ============== STORAGE ==============
const DATA_FILE = path.join(__dirname, 'bot_data.json');
let userData = {}; // { chatId: { emails: [], seenEmails: {} } }

// load existing data if present
try {
  if (fs.existsSync(DATA_FILE)) {
    userData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log("Loaded user data.");
  }
} catch (err) {
  console.error("Failed to load data:", err);
}

// helper to persist data
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
  } catch (err) {
    console.error("Failed to save data:", err);
  }
}

// ============== TELEGRAM HELPERS ==============
function sendTelegram(chatId, message, opts = {}) {
  return bot.sendMessage(chatId, message, opts).catch(err => {
    console.error("Telegram send error:", err.message);
  });
}

// ============== BARID.SITE HELPERS ==============
async function getDomains() {
  try {
    const res = await axios.get('https://api.barid.site/domains', { timeout: 10000 });
    if (res.data && res.data.success && Array.isArray(res.data.result)) {
      return res.data.result;
    }
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('getDomains error:', err.message);
    return [];
  }
}

function generateRandomEmail(domains) {
  const local = Math.random().toString(36).substring(2, 10);
  const domain = domains[Math.floor(Math.random() * domains.length)];
  return `${local}@${domain}`;
}

async function fetchEmailsForAddress(email) {
  try {
    const res = await axios.get(`https://api.barid.site/emails/${encodeURIComponent(email)}`, { timeout: 10000 });
    if (res.data && res.data.success && Array.isArray(res.data.result)) {
      return res.data.result;
    }
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error(`fetchEmailsForAddress(${email}) error:`, err.message);
    return [];
  }
}

async function fetchAttachmentsForAddress(email) {
  try {
    const res = await axios.get(`https://api.barid.site/emails/${encodeURIComponent(email)}/attachments?limit=50&offset=0`, { timeout: 10000 });
    if (res.data && res.data.success && Array.isArray(res.data.result)) {
      return res.data.result;
    }
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error(`fetchAttachmentsForAddress(${email}) error:`, err.message);
    return [];
  }
}

// Ensure user state exists
function ensureUser(chatId) {
  if (!userData[chatId]) {
    userData[chatId] = { emails: [], seenEmails: {} };
  }
}

// Check inbox for one user's email and notify
async function checkEmailInbox(chatId, email) {
  try {
    ensureUser(chatId);
    const mails = await fetchEmailsForAddress(email);

    if (!userData[chatId].seenEmails[email]) userData[chatId].seenEmails[email] = {};

    for (const mail of mails) {
      if (!userData[chatId].seenEmails[email][mail.id]) {
        userData[chatId].seenEmails[email][mail.id] = true;
        // Compose message
        const lines = [
          `📧 New email for ${email}`,
          `From: ${mail.from || 'unknown'}`,
          `Subject: ${mail.subject || '(no subject)'}`,
          `ID: ${mail.id}`
        ];
        if (mail.preview) lines.push(`Preview: ${mail.preview}`);
        await sendTelegram(chatId, lines.join('\n\n'));
        // attachments
        if (mail.hasAttachments) {
          const atts = await fetchAttachmentsForAddress(email);
          for (const att of atts) {
            await sendTelegram(chatId, `📎 Attachment: ${att.filename}\nSize: ${att.size || 'unknown'}\nURL: ${att.url}`);
          }
        }
        saveData();
      }
    }
  } catch (err) {
    console.error(`checkEmailInbox error for ${email}:`, err.message);
  }
}

// Poll all emails for a single user
async function pollAllEmailsForUser(chatId) {
  ensureUser(chatId);
  const list = userData[chatId].emails || [];
  for (const email of list) {
    await checkEmailInbox(chatId, email);
  }
}

// ================= TELEGRAM COMMANDS =================

// /start & /help
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  const welcome = `👋 Welcome — Barid Mail Bot
Available commands:
/new - create a new temporary email
/add <email> - track an existing email
/delete <email> - stop tracking an email
/list - show tracked emails
/check - manually check all emails
/clear - remove all tracked emails
/export - export tracked emails
/import <email1,email2,...> - import emails
/help - show this help message`;
  sendTelegram(chatId, welcome);
});
bot.onText(/\/help/, (msg) => bot.emit('text', { chat: { id: msg.chat.id }, text: '/start' }));

// /new
bot.onText(/\/new/, async (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  const domains = await getDomains();
  if (domains.length === 0) return sendTelegram(chatId, "❌ Could not fetch domains from barid.site");
  const newEmail = generateRandomEmail(domains);
  userData[chatId].emails.push(newEmail);
  saveData();
  sendTelegram(chatId, `🆕 New temporary email created: ${newEmail}`);
});

// /add <email>
bot.onText(/\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  const email = match[1].trim();
  if (!userData[chatId].emails.includes(email)) {
    userData[chatId].emails.push(email);
    saveData();
    sendTelegram(chatId, `✅ Now tracking: ${email}`);
  } else sendTelegram(chatId, `ℹ️ Already tracking: ${email}`);
});

// /delete <email>
bot.onText(/\/delete (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!userData[chatId]) return sendTelegram(chatId, "You have no tracked emails.");
  const email = match[1].trim();
  userData[chatId].emails = userData[chatId].emails.filter(e => e !== email);
  if (userData[chatId].seenEmails[email]) delete userData[chatId].seenEmails[email];
  saveData();
  sendTelegram(chatId, `🗑️ Stopped tracking: ${email}`);
});

// /list
bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  if (userData[chatId].emails.length === 0) return sendTelegram(chatId, "No tracked emails.");
  sendTelegram(chatId, `Tracked emails:\n${userData[chatId].emails.join("\n")}`);
});

// /check
bot.onText(/\/check/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  pollAllEmailsForUser(chatId);
  sendTelegram(chatId, "🔄 Manual check started...");
});

// /clear
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  userData[chatId].emails = [];
  userData[chatId].seenEmails = {};
  saveData();
  sendTelegram(chatId, "🗑️ Cleared all tracked emails.");
});

// /export
bot.onText(/\/export/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  if (userData[chatId].emails.length === 0) return sendTelegram(chatId, "No emails to export.");
  sendTelegram(chatId, `📤 Exported emails:\n${userData[chatId].emails.join("\n")}`);
});

// /import <list>
bot.onText(/\/import (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);
  const emails = match[1].split(',').map(e => e.trim()).filter(Boolean);
  for (const e of emails) {
    if (!userData[chatId].emails.includes(e)) userData[chatId].emails.push(e);
  }
  saveData();
  sendTelegram(chatId, `✅ Imported ${emails.length} emails.`);
});

// ============== AUTOMATIC POLLING ==============
setInterval(() => {
  Object.keys(userData).forEach(chatId => {
    pollAllEmailsForUser(chatId).catch(err => console.error(err));
  });
}, POLL_INTERVAL);

// startup message
console.log('Bot started. Poll interval (ms):', POLL_INTERVAL);