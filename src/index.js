// src/index.js — v3 (fixed double responses + better error handling)

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');
const prisma = require('./utils/db');

const { registerCommands } = require('./handlers/commandHandler');
const { registerFileHandler, zipSessions } = require('./handlers/fileHandler');
const { registerImageHandler } = require('./handlers/imageHandler');
const { registerCallbackHandler } = require('./handlers/callbackHandler');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { startCleanupJob } = require('./jobs/cleanupJob');

// ── Validate env ───────────────────────────────────────────────────────────────
const required = ['BOT_TOKEN', 'ADMIN_CHAT_ID', 'DATABASE_URL'];
for (const key of required) {
  if (!process.env[key]) {
    logger.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

// ── Ensure temp dir ────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(process.cwd(), process.env.TEMP_DIR || 'temp');
fs.ensureDirSync(TEMP_DIR);

// ── Deduplication: prevent processing the same update twice ───────────────────
// This fixes the double-response bug when bot restarts mid-processing
const processedUpdateIds = new Set();
const MAX_DEDUP_CACHE = 500;

function isDuplicate(updateId) {
  if (processedUpdateIds.has(updateId)) return true;
  processedUpdateIds.add(updateId);
  // Keep cache size bounded
  if (processedUpdateIds.size > MAX_DEDUP_CACHE) {
    const first = processedUpdateIds.values().next().value;
    processedUpdateIds.delete(first);
  }
  return false;
}

// ── Init bot ───────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
  filepath: true,
});

// ── Deduplication middleware — wraps ALL incoming updates ──────────────────────
bot.on('polling_error', (err) => logger.error(`Polling error: ${err.code} — ${err.message}`));

const _originalProcess = bot._buildMessageFromParams?.bind(bot);

// Intercept at the raw update level
const originalGetUpdates = bot._polling?.getUpdates?.bind(bot._polling);
if (bot._polling) {
  const originalOnUpdate = bot._polling._onUpdate?.bind(bot._polling);
  if (originalOnUpdate) {
    bot._polling._onUpdate = function(update) {
      if (update?.update_id && isDuplicate(update.update_id)) {
        logger.warn(`Duplicate update ${update.update_id} skipped`);
        return;
      }
      return originalOnUpdate(update);
    };
  }
}

// ── Register handlers (ORDER MATTERS) ─────────────────────────────────────────
registerCommands(bot);
registerFileHandler(bot);
registerImageHandler(bot);
const { pendingEdits, pendingPrompts } = registerCallbackHandler(bot, zipSessions);
registerMessageHandler(bot, zipSessions, pendingEdits, pendingPrompts);

// ── Start cron jobs ────────────────────────────────────────────────────────────
startCleanupJob(bot, process.env.ADMIN_CHAT_ID);

// ── Global error handling — DO NOT crash on recoverable errors ─────────────────
bot.on('error', (err) => logger.error(`Bot error: ${err.message}`));
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  // DO NOT exit — let the bot keep running
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  // Only exit on truly fatal errors (e.g. out of memory), not API errors
  if (err.message && (
    err.message.includes('Cannot read') ||
    err.message.includes('ENOMEM') ||
    err.message.includes('ENOSPC')
  )) {
    process.exit(1);
  }
  // For all other errors, log and keep running
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  await bot.stopPolling();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Health check HTTP server ───────────────────────────────────────────────────
const http = require('http');
const HEALTH_PORT = parseInt(process.env.PORT || '8080', 10);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: 'awesome-bot', uptime: process.uptime() }));
}).listen(HEALTH_PORT, () => logger.info(`🌐 Health server on :${HEALTH_PORT}`));

// ── Start ──────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    logger.info('✅ PostgreSQL connected');

    const me = await bot.getMe();
    logger.info(`🤖 Bot started: @${me.username}`);

    try {
      await bot.sendMessage(
        process.env.ADMIN_CHAT_ID,
        `🚀 *D'Awesome Bot v3 started*\n@${me.username} is online.\n\n` +
        `Features: Image Vision ✅ | ZIP IDE ✅ | GitHub ✅ | Memory ✅ | Projects ✅\n` +
        `Free AI: Pollinations ✅ | HuggingFace ✅ | Groq ✅`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}

    logger.info("🟢 D'Awesome Bot v3 running");
  } catch (err) {
    logger.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
}

start();
