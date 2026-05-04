// src/index.js — v2
// OmegaTech Claude AI Telegram Bot — Entry Point

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

// ── Init bot ───────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
  filepath: true,
});

// ── Register handlers (ORDER MATTERS) ─────────────────────────────────────────
registerCommands(bot);
registerFileHandler(bot);          // documents (zip, code) — must be before message
registerImageHandler(bot);         // photos + image documents
const { pendingEdits, pendingPrompts } = registerCallbackHandler(bot, zipSessions);
registerMessageHandler(bot, zipSessions, pendingEdits, pendingPrompts);

// ── Start cron jobs ────────────────────────────────────────────────────────────
startCleanupJob(bot, process.env.ADMIN_CHAT_ID);

// ── Global error handling ──────────────────────────────────────────────────────
bot.on('polling_error', (err) => logger.error(`Polling error: ${err.code} — ${err.message}`));
bot.on('error', (err) => logger.error(`Bot error: ${err.message}`));
process.on('unhandledRejection', (r) => logger.error(`Unhandled rejection: ${r}`));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  process.exit(1);
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

// ── Health check HTTP server (required by Fly.io [http_service] on port 8080) ──
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
        `🚀 *OmegaTech Bot v2 started*\n@${me.username} is online.\n\n` +
        `Features: Image Vision ✅ | ZIP IDE ✅ | GitHub ✅ | Memory ✅ | Projects ✅`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}

    logger.info('🟢 OmegaTech Claude Bot v2 running');
  } catch (err) {
    logger.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
}

start();
