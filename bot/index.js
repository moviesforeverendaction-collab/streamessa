/**
 * StreamyFlix Bot — Production Telegram File Indexer + Streaming Proxy
 *
 * Features:
 * 1. Auto-indexes files sent to the bot or posted in the private channel
 * 2. Prompts admin to index all files from a forwarded channel
 * 3. Delivers files to users via /start deep-links
 * 4. Force-subscribe check before download
 * 5. REST API for the website (list indexed files, search, stream proxy)
 * 6. Webhook support for production deployment
 *
 * Deploy: Railway / Render / VPS with PM2
 * Env vars: see .env.example
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const TelegramBot = require("node-telegram-bot-api");
const https = require("https");
const http = require("http");

// ─── Config ──────────────────────────────────────────────────────────────────
const {
  BOT_TOKEN,
  CHANNEL_ID,
  ADMIN_USER_IDS = "",
  MONGO_URI,
  MONGO_DB = "streamyflix",
  MONGO_COLLECTION = "files",
  PORT = 3001,
  WEBSITE_URL = "",
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!MONGO_URI) throw new Error("MONGO_URI is required");

const ADMINS = ADMIN_USER_IDS.split(",").map(Number).filter(Boolean);

// ─── MongoDB ─────────────────────────────────────────────────────────────────
let db, filesCol;
const mongoClient = new MongoClient(MONGO_URI);

async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db(MONGO_DB);
  filesCol = db.collection(MONGO_COLLECTION);
  // Indexes for fast queries
  await filesCol.createIndex({ file_unique_id: 1 }, { unique: true });
  await filesCol.createIndex({ tmdb_id: 1 });
  await filesCol.createIndex({ media_type: 1 });
  await filesCol.createIndex({ file_name: "text", title: "text" });
  console.log(`✅ MongoDB connected: ${MONGO_DB}.${MONGO_COLLECTION}`);
}

// ─── Telegram Bot ────────────────────────────────────────────────────────────
// Use polling in dev, webhook in production
const isWebhook = !!process.env.WEBHOOK_URL;
const bot = new TelegramBot(BOT_TOKEN, {
  polling: !isWebhook,
  ...(isWebhook ? {} : {}),
});

function isAdmin(userId) {
  return ADMINS.includes(userId);
}

// ─── File Extraction Helper ──────────────────────────────────────────────────
function extractFileInfo(msg) {
  let fileObj = null;
  let fileType = "unknown";

  if (msg.document) {
    fileObj = msg.document;
    fileType = "document";
  } else if (msg.video) {
    fileObj = msg.video;
    fileType = "video";
  } else if (msg.audio) {
    fileObj = msg.audio;
    fileType = "audio";
  } else if (msg.animation) {
    fileObj = msg.animation;
    fileType = "animation";
  }

  if (!fileObj) return null;

  // Attempt to detect quality from filename
  const fileName = fileObj.file_name || msg.caption || "Untitled";
  let quality = "Unknown";
  if (/2160p|4k|uhd/i.test(fileName)) quality = "4K UHD";
  else if (/1080p/i.test(fileName)) quality = "1080p HD";
  else if (/720p/i.test(fileName)) quality = "720p HD";
  else if (/480p/i.test(fileName)) quality = "480p SD";
  else if (/360p/i.test(fileName)) quality = "360p";

  // Detect language
  let language = "Unknown";
  const langMap = {
    english: "English", hindi: "Hindi", tamil: "Tamil", telugu: "Telugu",
    malayalam: "Malayalam", kannada: "Kannada", spanish: "Spanish",
    french: "French", korean: "Korean", japanese: "Japanese",
    dual: "Dual Audio", multi: "Multi Audio",
  };
  for (const [key, val] of Object.entries(langMap)) {
    if (new RegExp(key, "i").test(fileName)) { language = val; break; }
  }

  // Detect season/episode
  let season = null, episode = null;
  const seMatch = fileName.match(/S(\d{1,3})E(\d{1,4})/i);
  if (seMatch) { season = parseInt(seMatch[1]); episode = parseInt(seMatch[2]); }
  else {
    const sMatch = fileName.match(/Season\s*(\d{1,3})/i);
    if (sMatch) season = parseInt(sMatch[1]);
  }

  // Determine media_type
  let media_type = "unknown";
  if (season !== null || /series|S\d{1,3}/i.test(fileName)) media_type = "tv";
  else media_type = "movie";

  // Clean title
  let title = fileName
    .replace(/\.(mkv|mp4|avi|mov|webm|flv|wmv|ts|m4v)$/i, "")
    .replace(/[\[\(].*?[\]\)]/g, "")
    .replace(/\d{3,4}p.*$/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    file_id: fileObj.file_id,
    file_unique_id: fileObj.file_unique_id,
    file_name: fileName,
    file_size: fileObj.file_size || 0,
    mime_type: fileObj.mime_type || "application/octet-stream",
    duration: fileObj.duration || null,
    message_id: msg.message_id,
    channel_id: String(msg.chat.id),
    tmdb_id: null,
    media_type,
    title,
    quality,
    language,
    season,
    episode,
    file_type: fileType,
    indexed_at: new Date().toISOString(),
    download_count: 0,
    thumb: fileObj.thumb?.file_id || fileObj.thumbnail?.file_id || null,
  };
}

// ─── Index a file into MongoDB ───────────────────────────────────────────────
async function indexFile(fileInfo) {
  try {
    const result = await filesCol.updateOne(
      { file_unique_id: fileInfo.file_unique_id },
      { $set: fileInfo },
      { upsert: true }
    );
    return { ok: true, upserted: !!result.upsertedId };
  } catch (e) {
    console.error("Index error:", e.message);
    return { ok: false, error: e.message };
  }
}

// ─── Bot: /start command ─────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const param = (match[1] || "").trim();

  // Deep-link download: /start dl_movie_550_1080p_hd
  if (param.startsWith("dl_")) {
    const parts = param.replace("dl_", "").split("_");
    // Could be: movie_550, movie_550_1080p_hd, tv_123_s1_e5, etc.

    // Force-sub check
    if (CHANNEL_ID) {
      try {
        const member = await bot.getChatMember(CHANNEL_ID, userId);
        if (!["member", "administrator", "creator"].includes(member.status)) {
          const channelLink = process.env.FORCE_SUB_LINK || `https://t.me/${CHANNEL_ID.replace("-100", "")}`;
          return bot.sendMessage(chatId,
            `⚠️ <b>Please join our channel first!</b>\n\n` +
            `You must be a member of our channel to download files.\n\n` +
            `👉 <a href="${channelLink}">Join Channel</a>\n\n` +
            `Then try again: /start ${param}`,
            { parse_mode: "HTML", disable_web_page_preview: true }
          );
        }
      } catch (e) {
        // If bot can't check, skip force-sub
        console.log("Force-sub check failed:", e.message);
      }
    }

    // Search for the file in MongoDB
    let query = {};
    if (parts[0] === "movie" || parts[0] === "tv") {
      const tmdbId = parseInt(parts[1]);
      if (!isNaN(tmdbId)) {
        query = { tmdb_id: tmdbId, media_type: parts[0] };
        // Add quality filter if specified
        if (parts.length > 2) {
          const qualityStr = parts.slice(2).join(" ").replace(/_/g, " ");
          if (qualityStr.startsWith("s")) {
            // Season/episode format: s1_e5
            const sNum = parseInt(qualityStr.replace("s", ""));
            query.season = sNum;
            if (parts.length > 3 && parts[3].startsWith("e")) {
              query.episode = parseInt(parts[3].replace("e", ""));
            }
          }
        }
      }
    }

    // Also try searching by content ID (from local library)
    const files = await filesCol.find(query).sort({ quality: -1 }).limit(10).toArray();

    if (files.length === 0) {
      return bot.sendMessage(chatId,
        `❌ <b>File not found</b>\n\nThe requested content isn't available yet. It may have been removed or not indexed.\n\n🔍 Try searching on our website.`,
        { parse_mode: "HTML" }
      );
    }

    // Send all matching files
    for (const file of files) {
      try {
        const caption =
          `🎬 <b>${file.title || file.file_name}</b>\n` +
          `📀 Quality: ${file.quality}\n` +
          `🌐 Language: ${file.language}\n` +
          `📦 Size: ${file.file_size ? (file.file_size / 1024 / 1024 / 1024).toFixed(2) + " GB" : "Unknown"}\n` +
          (file.season ? `📺 Season ${file.season}${file.episode ? ` Episode ${file.episode}` : ""}` : "");

        if (file.mime_type?.startsWith("video/")) {
          await bot.sendVideo(chatId, file.file_id, {
            caption, parse_mode: "HTML", supports_streaming: true,
          });
        } else {
          await bot.sendDocument(chatId, file.file_id, {
            caption, parse_mode: "HTML",
          });
        }

        // Increment download count
        await filesCol.updateOne(
          { file_unique_id: file.file_unique_id },
          { $inc: { download_count: 1 } }
        );
      } catch (e) {
        console.error("Send file error:", e.message);
        await bot.sendMessage(chatId, `❌ Error sending file: ${e.message}`);
      }
    }
    return;
  }

  // Normal /start — welcome message
  const botInfo = await bot.getMe();
  const welcomeText =
    `🎬 <b>Welcome to StreamyFlix Bot!</b>\n\n` +
    `I can help you download movies, series, and anime directly to your Telegram.\n\n` +
    `<b>How to use:</b>\n` +
    `• Visit our website and click Download on any movie\n` +
    `• Send me a file to index it\n` +
    `• Forward a file from a channel to index it\n\n` +
    (isAdmin(userId)
      ? `⚡ <b>Admin commands:</b>\n/stats — Bot statistics\n/index — Index channel files\n/search &lt;query&gt; — Search indexed files\n\n`
      : "") +
    (WEBSITE_URL ? `🌐 <a href="${WEBSITE_URL}">Visit Website</a>` : "");

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        ...(WEBSITE_URL ? [[{ text: "🌐 Visit Website", url: WEBSITE_URL }]] : []),
        [{ text: "📢 Join Channel", url: process.env.FORCE_SUB_LINK || `https://t.me/${(CHANNEL_ID || "").replace("-100", "")}` }],
      ],
    },
  });
});

// ─── Bot: File received (DM or channel) ─────────────────────────────────────
async function handleFile(msg) {
  const fileInfo = extractFileInfo(msg);
  if (!fileInfo) return;

  const result = await indexFile(fileInfo);
  const chatId = msg.chat.id;

  // Only send confirmation in private chats
  if (msg.chat.type === "private") {
    if (result.ok) {
      const text =
        `✅ <b>File Indexed!</b>\n\n` +
        `📄 <b>${fileInfo.file_name}</b>\n` +
        `📀 Quality: ${fileInfo.quality}\n` +
        `🌐 Language: ${fileInfo.language}\n` +
        `📦 Size: ${fileInfo.file_size ? (fileInfo.file_size / 1024 / 1024 / 1024).toFixed(2) + " GB" : "Unknown"}\n` +
        `🏷️ Type: ${fileInfo.media_type}\n` +
        (fileInfo.season ? `📺 S${fileInfo.season}${fileInfo.episode ? `E${fileInfo.episode}` : ""}\n` : "") +
        `\n🔗 File ID: <code>${fileInfo.file_id.slice(0, 30)}…</code>`;

      bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📝 Edit Title", callback_data: `edit_title_${fileInfo.file_unique_id}` }],
            [{ text: "🔗 Link to TMDB", callback_data: `link_tmdb_${fileInfo.file_unique_id}` }],
          ],
        },
      });
    } else {
      bot.sendMessage(chatId, `❌ Index failed: ${result.error}`);
    }
  }
}

// Listen for files in private chats
bot.on("document", handleFile);
bot.on("video", handleFile);
bot.on("audio", handleFile);

// Listen for channel posts (auto-index)
bot.on("channel_post", async (msg) => {
  if (CHANNEL_ID && String(msg.chat.id) === String(CHANNEL_ID)) {
    await handleFile(msg);
  }
});

// ─── Bot: Forward detection → Index all from channel ─────────────────────────
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  if (!isAdmin(msg.from.id)) return;

  // Detect forwarded message from a channel
  if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
    const fromChannel = msg.forward_from_chat;

    // Check if it has a file
    if (msg.document || msg.video || msg.audio) {
      await handleFile(msg);
    }

    // Prompt admin: "Do you want to index all files from this channel?"
    bot.sendMessage(msg.chat.id,
      `📢 <b>Channel Detected!</b>\n\n` +
      `You forwarded from: <b>${fromChannel.title}</b>\n` +
      `Channel ID: <code>${fromChannel.id}</code>\n\n` +
      `Would you like me to index ALL files from this channel?\n` +
      `<i>I'll scan recent messages and index any files I find.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Yes, Index All", callback_data: `index_channel_${fromChannel.id}` },
              { text: "❌ No", callback_data: "dismiss" },
            ],
          ],
        },
      }
    );
  }
});

// ─── Bot: Callback queries ───────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // Dismiss
  if (data === "dismiss") {
    await bot.answerCallbackQuery(query.id, { text: "Dismissed" });
    return bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
  }

  // Index all from channel
  if (data.startsWith("index_channel_")) {
    if (!isAdmin(userId)) {
      return bot.answerCallbackQuery(query.id, { text: "❌ Admin only", show_alert: true });
    }

    const channelId = data.replace("index_channel_", "");
    await bot.answerCallbackQuery(query.id, { text: "🔄 Starting indexing..." });
    await bot.editMessageText(
      `⏳ <b>Indexing channel</b> <code>${channelId}</code>…\n\nThis may take a while. I'll update you when done.`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
    );

    // Iterate through recent messages using getChat + forwardMessage trick
    // The bot needs to be admin in the channel
    let indexed = 0, skipped = 0, errors = 0;
    let maxId = 0;

    // Try to get the latest message ID by sending a test message and deleting it
    try {
      const testMsg = await bot.sendMessage(channelId, "🔄 Indexing in progress…");
      maxId = testMsg.message_id;
      await bot.deleteMessage(channelId, testMsg.message_id);
    } catch (e) {
      await bot.editMessageText(
        `❌ <b>Cannot access channel</b> <code>${channelId}</code>\n\nMake sure the bot is an admin with "Post Messages" permission.\n\nError: ${e.message}`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
      );
      return;
    }

    // Iterate backward from maxId
    const startFrom = Math.max(1, maxId - 500); // Scan last 500 messages max
    for (let msgId = maxId; msgId >= startFrom; msgId--) {
      try {
        const forwarded = await bot.forwardMessage(chatId, channelId, msgId);

        if (forwarded.document || forwarded.video || forwarded.audio) {
          // Override channel_id to the source channel
          const fileInfo = extractFileInfo(forwarded);
          if (fileInfo) {
            fileInfo.channel_id = channelId;
            fileInfo.message_id = msgId; // original message ID
            const result = await indexFile(fileInfo);
            if (result.ok) indexed++;
            else errors++;
          }
        } else {
          skipped++;
        }

        // Delete the forwarded message (cleanup)
        await bot.deleteMessage(chatId, forwarded.message_id).catch(() => {});

        // Throttle to avoid rate limits
        if (msgId % 20 === 0) {
          await new Promise(r => setTimeout(r, 1000));
          // Update progress
          await bot.editMessageText(
            `⏳ <b>Indexing…</b>\n\n📊 Progress: ${maxId - msgId}/${maxId - startFrom} messages scanned\n✅ Indexed: ${indexed}\n⏭️ Skipped (no file): ${skipped}\n❌ Errors: ${errors}`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
          ).catch(() => {});
        }
      } catch (e) {
        // Message doesn't exist or can't be forwarded — skip
        skipped++;
      }
    }

    // Final report
    await bot.editMessageText(
      `✅ <b>Indexing Complete!</b>\n\n📊 Summary:\n• ✅ Files indexed: <b>${indexed}</b>\n• ⏭️ Messages skipped: ${skipped}\n• ❌ Errors: ${errors}\n• 📐 Messages scanned: ${maxId - startFrom}\n\n🌐 Refresh the Admin panel on the website to see the indexed files.`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
    );
    return;
  }

  // Link to TMDB
  if (data.startsWith("link_tmdb_")) {
    const fileUniqueId = data.replace("link_tmdb_", "");
    await bot.answerCallbackQuery(query.id, { text: "Send me the TMDB ID" });
    await bot.sendMessage(chatId,
      `🔗 <b>Link to TMDB</b>\n\nSend me the TMDB ID (number) for this file.\nFormat: <code>tmdb MOVIE 550</code> or <code>tmdb TV 1399</code>`,
      { parse_mode: "HTML" }
    );
    // Store pending action
    if (!global._pendingLinks) global._pendingLinks = {};
    global._pendingLinks[userId] = fileUniqueId;
    return;
  }

  // Edit title
  if (data.startsWith("edit_title_")) {
    const fileUniqueId = data.replace("edit_title_", "");
    await bot.answerCallbackQuery(query.id, { text: "Send me the new title" });
    await bot.sendMessage(chatId,
      `📝 <b>Edit Title</b>\n\nSend me the new title for this file.\nFormat: <code>title Your New Title Here</code>`,
      { parse_mode: "HTML" }
    );
    if (!global._pendingTitles) global._pendingTitles = {};
    global._pendingTitles[userId] = fileUniqueId;
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

// ─── Bot: Text commands (TMDB link, title edit, search) ──────────────────────
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private" || !msg.text) return;
  const text = msg.text.trim();
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Handle pending TMDB link
  if (text.toLowerCase().startsWith("tmdb ") && global._pendingLinks?.[userId]) {
    const parts = text.split(/\s+/);
    const mediaType = parts[1]?.toLowerCase();
    const tmdbId = parseInt(parts[2]);

    if (!mediaType || !tmdbId) {
      return bot.sendMessage(chatId, "❌ Format: <code>tmdb MOVIE 550</code> or <code>tmdb TV 1399</code>", { parse_mode: "HTML" });
    }

    const fileUniqueId = global._pendingLinks[userId];
    delete global._pendingLinks[userId];

    const result = await filesCol.updateOne(
      { file_unique_id: fileUniqueId },
      { $set: { tmdb_id: tmdbId, media_type: mediaType === "tv" ? "tv" : "movie" } }
    );

    if (result.modifiedCount) {
      bot.sendMessage(chatId, `✅ Linked to TMDB ID <b>${tmdbId}</b> (${mediaType})`, { parse_mode: "HTML" });
    } else {
      bot.sendMessage(chatId, `❌ File not found in database`);
    }
    return;
  }

  // Handle pending title edit
  if (text.toLowerCase().startsWith("title ") && global._pendingTitles?.[userId]) {
    const newTitle = text.replace(/^title\s+/i, "").trim();
    const fileUniqueId = global._pendingTitles[userId];
    delete global._pendingTitles[userId];

    const result = await filesCol.updateOne(
      { file_unique_id: fileUniqueId },
      { $set: { title: newTitle } }
    );

    if (result.modifiedCount) {
      bot.sendMessage(chatId, `✅ Title updated to: <b>${newTitle}</b>`, { parse_mode: "HTML" });
    } else {
      bot.sendMessage(chatId, `❌ File not found in database`);
    }
    return;
  }

  // /stats — admin only
  if (text === "/stats" && isAdmin(userId)) {
    const total = await filesCol.countDocuments();
    const movies = await filesCol.countDocuments({ media_type: "movie" });
    const tv = await filesCol.countDocuments({ media_type: "tv" });
    const linked = await filesCol.countDocuments({ tmdb_id: { $ne: null } });
    const totalDownloads = await filesCol.aggregate([
      { $group: { _id: null, total: { $sum: "$download_count" } } }
    ]).toArray();

    bot.sendMessage(chatId,
      `📊 <b>Bot Statistics</b>\n\n` +
      `📁 Total files: <b>${total}</b>\n` +
      `🎬 Movies: ${movies}\n` +
      `📺 TV Series: ${tv}\n` +
      `🔗 TMDB Linked: ${linked}\n` +
      `📥 Total Downloads: ${totalDownloads[0]?.total || 0}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // /search <query> — search indexed files
  if (text.startsWith("/search ")) {
    const query = text.replace("/search ", "").trim();
    if (!query) return bot.sendMessage(chatId, "Usage: /search <movie name>");

    const results = await filesCol.find(
      { $text: { $search: query } },
      { score: { $meta: "textScore" } }
    ).sort({ score: { $meta: "textScore" } }).limit(10).toArray();

    if (results.length === 0) {
      return bot.sendMessage(chatId, `🔍 No results for "<b>${query}</b>"`, { parse_mode: "HTML" });
    }

    let text2 = `🔍 <b>Search Results for "${query}"</b>\n\n`;
    for (const f of results) {
      const sizeGB = f.file_size ? (f.file_size / 1024 / 1024 / 1024).toFixed(2) + " GB" : "?";
      text2 += `📄 <b>${f.title || f.file_name}</b>\n`;
      text2 += `   ${f.quality} • ${f.language} • ${sizeGB}\n\n`;
    }

    bot.sendMessage(chatId, text2, { parse_mode: "HTML" });
    return;
  }

  // /index — prompt to re-index configured channel
  if (text === "/index" && isAdmin(userId)) {
    if (!CHANNEL_ID) {
      return bot.sendMessage(chatId, "❌ CHANNEL_ID not configured in environment variables.");
    }

    bot.sendMessage(chatId,
      `📢 <b>Re-index Channel</b>\n\nChannel: <code>${CHANNEL_ID}</code>\n\nThis will scan the last 500 messages and index any files found.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Start Indexing", callback_data: `index_channel_${CHANNEL_ID}` },
              { text: "❌ Cancel", callback_data: "dismiss" },
            ],
          ],
        },
      }
    );
    return;
  }
});

// ─── Express API Server ──────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", async (req, res) => {
  let dbStatus = "disconnected";
  try {
    await db.command({ ping: 1 });
    dbStatus = "connected";
  } catch { dbStatus = "error"; }

  let botStatus = false;
  try {
    await bot.getMe();
    botStatus = true;
  } catch { botStatus = false; }

  res.json({
    status: "ok",
    db: dbStatus,
    bot: botStatus,
    timestamp: new Date().toISOString(),
    files: await filesCol.countDocuments().catch(() => 0),
  });
});

// List indexed files
app.get("/api/files", async (req, res) => {
  try {
    const query = {};
    if (req.query.type) query.media_type = req.query.type;
    if (req.query.tmdb_id) query.tmdb_id = parseInt(req.query.tmdb_id);
    if (req.query.quality) query.quality = req.query.quality;

    const files = await filesCol.find(query)
      .sort({ indexed_at: -1 })
      .limit(parseInt(req.query.limit) || 200)
      .toArray();

    res.json({ ok: true, files, count: files.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Search
app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ ok: true, files: [] });

    const files = await filesCol.find(
      { $text: { $search: q } },
      { score: { $meta: "textScore" } }
    ).sort({ score: { $meta: "textScore" } }).limit(50).toArray();

    res.json({ ok: true, files, count: files.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Link file to TMDB
app.post("/api/link", async (req, res) => {
  try {
    const { file_unique_id, tmdb_id, media_type, title } = req.body;
    if (!file_unique_id || !tmdb_id) {
      return res.status(400).json({ ok: false, error: "file_unique_id and tmdb_id required" });
    }

    const result = await filesCol.updateOne(
      { file_unique_id },
      { $set: { tmdb_id: parseInt(tmdb_id), media_type: media_type || "movie", ...(title ? { title } : {}) } }
    );

    res.json({ ok: true, modified: result.modifiedCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stream proxy (for files ≤ 20MB via Bot API)
app.get("/stream", async (req, res) => {
  try {
    const { file_id } = req.query;
    if (!file_id) return res.status(400).json({ error: "file_id required" });

    // Get file path from Bot API
    const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id }),
    });
    const fileData = await fileRes.json();

    if (!fileData.ok) {
      // File too large for Bot API — need MTProto
      return res.status(413).json({
        error: "File too large for Bot API (>20MB). Use MTProto streaming backend.",
        description: fileData.description,
      });
    }

    const filePath = fileData.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    // Proxy the file
    const protocol = downloadUrl.startsWith("https") ? https : http;
    protocol.get(downloadUrl, (proxyRes) => {
      res.set({
        "Content-Type": proxyRes.headers["content-type"] || "application/octet-stream",
        "Content-Length": proxyRes.headers["content-length"],
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      });
      proxyRes.pipe(res);
    }).on("error", (e) => {
      res.status(500).json({ error: e.message });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// File info by ID
app.get("/api/file/:id", async (req, res) => {
  try {
    let file;
    try {
      file = await filesCol.findOne({ _id: new ObjectId(req.params.id) });
    } catch {
      file = await filesCol.findOne({ file_unique_id: req.params.id });
    }
    if (!file) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, file });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete file from index
app.delete("/api/file/:id", async (req, res) => {
  try {
    let result;
    try {
      result = await filesCol.deleteOne({ _id: new ObjectId(req.params.id) });
    } catch {
      result = await filesCol.deleteOne({ file_unique_id: req.params.id });
    }
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Webhook endpoint
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  const botInfo = await bot.getMe();
  console.log(`🤖 Bot started: @${botInfo.username} (${botInfo.id})`);

  app.listen(PORT, () => {
    console.log(`🚀 API server running on port ${PORT}`);
    console.log(`📡 Mode: ${isWebhook ? "Webhook" : "Polling"}`);
    console.log(`📂 Channel: ${CHANNEL_ID || "(not set)"}`);
    console.log(`👑 Admins: ${ADMINS.join(", ") || "(none)"}`);
  });
}

start().catch((e) => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});
