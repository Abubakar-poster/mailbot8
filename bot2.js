require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= CONFIG ==================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN not set!");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);

// ================= STORAGE ==================
const DATA_FILE = path.join(__dirname, "bot_data.json");
let userData = {};

try {
  if (fs.existsSync(DATA_FILE)) {
    userData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch (err) {
  console.error("Failed to load user data:", err);
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
  } catch (err) {
    console.error("Failed to save data:", err);
  }
}

// ================= HELPERS ==================
function ensureUser(chatId) {
  if (!userData[chatId]) {
    userData[chatId] = { emails: [], seenEmails: {} };
  }
}

async function getDomains() {
  try {
    const res = await axios.get("https://api.barid.site/domains", { timeout: 10000 });
    return res.data;
  } catch (err) {
    return [];
  }
}

function generateRandomEmail(domains) {
  const local = Math.random().toString(36).substring(2, 10);
  const domain = domains[Math.floor(Math.random() * domains.length)];
  return `${local}@${domain}`;
}

async function fetchEmails(email) {
  try {
    const res = await axios.get(`https://api.barid.site/emails/${email}`, { timeout: 10000 });
    return res.data;
  } catch (err) {
    return [];
  }
}

async function fetchAttachments(email) {
  try {
    const res = await axios.get(`https://api.barid.site/emails/${email}/attachments?limit=50&offset=0`, { timeout: 10000 });
    return res.data;
  } catch (err) {
    return [];
  }
}

async function checkEmailInbox(chatId, email) {
  try {
    ensureUser(chatId);

    const messages = await fetchEmails(email);
    if (!userData[chatId].seenEmails[email])
      userData[chatId].seenEmails[email] = {};

    for (const mail of messages) {
      if (!userData[chatId].seenEmails[email][mail.id]) {
        userData[chatId].seenEmails[email][mail.id] = true;

        const msg = [
          `📥 *New Email Received*`,
          `📧 Email: *${email}*`,
          `👤 From: ${mail.from || "Unknown"}`,
          `📝 Subject: ${mail.subject || "(No subject)"}`,
          `🔑 ID: ${mail.id}`,
          mail.preview ? `🧾 Preview: ${mail.preview}` : ""
        ].join("\n");

        await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });

        if (mail.hasAttachments) {
          const atts = await fetchAttachments(email);
          for (const a of atts) {
            await bot.sendMessage(
              chatId,
              `📎 Attachment:\nFile: *${a.filename}*\nURL: ${a.url}`,
              { parse_mode: "Markdown" }
            );
          }
        }

        saveData();
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function pollUser(chatId) {
  ensureUser(chatId);
  for (const email of userData[chatId].emails) {
    await checkEmailInbox(chatId, email);
  }
}

// ================= COMMANDS ==================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);

  bot.sendMessage(chatId,
`👋 *Welcome to TikTok Shop Email Bot*

Commands:
• /new – create new random email  
• /add <email> – track existing email  
• /delete <email> – remove tracked email  
• /list – show your tracked emails  
• /check – manually check inbox  
• /export – export emails  
• /import email1,email2,email3  
• /clear – delete all  

Bot checks automatically every ${POLL_INTERVAL / 1000} seconds.`,
  { parse_mode: "Markdown" });
});

// Create new email
bot.onText(/\/new/, async (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);

  const domains = await getDomains();
  if (domains.length === 0) {
    return bot.sendMessage(chatId, "❌ Could not get domains");
  }

  const newEmail = generateRandomEmail(domains);
  userData[chatId].emails.push(newEmail);
  saveData();

  bot.sendMessage(chatId, `🎉 *New Email Created*:\n${newEmail}`, { parse_mode: "Markdown" });
});

// Add existing email
bot.onText(/\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const email = match[1].trim();
  ensureUser(chatId);

  if (!userData[chatId].emails.includes(email)) {
    userData[chatId].emails.push(email);
    saveData();
  }

  bot.sendMessage(chatId, `✅ Tracking started: ${email}`);
});

// Delete email
bot.onText(/\/delete (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const email = match[1].trim();
  ensureUser(chatId);

  userData[chatId].emails = userData[chatId].emails.filter(e => e !== email);
  saveData();

  bot.sendMessage(chatId, `🗑 Removed: ${email}`);
});

// List
bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);

  if (userData[chatId].emails.length === 0)
    return bot.sendMessage(chatId, "No emails tracked yet.");

  bot.sendMessage(chatId, "📌 Your Emails:\n" + userData[chatId].emails.join("\n"));
});

// Manual check
bot.onText(/\/check/, (msg) => {
  pollUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, "🔍 Checking inbox...");
});

// Clear
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);

  userData[chatId] = { emails: [], seenEmails: {} };
  saveData();

  bot.sendMessage(chatId, "🧹 All emails cleared.");
});

// Export
bot.onText(/\/export/, (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);

  bot.sendMessage(chatId, "📤 Exported:\n" + userData[chatId].emails.join("\n"));
});

// Import
bot.onText(/\/import (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  ensureUser(chatId);

  const emails = match[1].split(",").map(e => e.trim());
  for (const email of emails) {
    if (!userData[chatId].emails.includes(email))
      userData[chatId].emails.push(email);
  }
  saveData();

  bot.sendMessage(chatId, `📥 Imported ${emails.length} email(s).`);
});

// ================= POLLING ==================
setInterval(() => {
  Object.keys(userData).forEach(chatId => pollUser(chatId));
}, POLL_INTERVAL);

console.log("Bot running with polling interval", POLL_INTERVAL);