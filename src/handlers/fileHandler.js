// src/handlers/fileHandler.js — v2

const path = require('path');
const fs = require('fs-extra');
const { getOrCreateUser, isUserBanned } = require('../services/userService');
const { downloadTelegramFile, readTextFile } = require('../services/fileService');
const { askClaudeWithContext } = require('../services/claudeService');
const { extractZip, formatManifest, packZip, readFile, writeFile, buildProjectContext, buildManifest } = require('../services/zipService');
const { saveProject } = require('../services/projectService');
const { incrementStat } = require('../services/statsService');
const { getUserTempDir, uniqueFilename, splitIntoChunks } = require('../utils/helpers');
const { zipMainKeyboard } = require('../utils/keyboards');
const prisma = require('../utils/db');
const logger = require('../utils/logger');

// Shared zip session store: userId -> { extractDir, manifest, originalName }
const zipSessions = new Map();

function registerFileHandler(bot) {
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (await isUserBanned(userId)) return bot.sendMessage(chatId, '🚫 You are banned.');

    const doc = msg.document;
    const fileName = doc.file_name || 'file';
    const ext = path.extname(fileName).toLowerCase();
    const mime = doc.mime_type || '';

    // Images handled by imageHandler
    if (mime.startsWith('image/')) return;

    const dbUser = await getOrCreateUser(msg);
    const statusMsg = await bot.sendMessage(chatId, `📥 Downloading *${fileName}*...`, { parse_mode: 'Markdown' });

    try {
      const { localPath, fileType, fileSize } = await downloadTelegramFile(bot, doc.file_id, userId, fileName);

      await prisma.fileSession.create({ data: { userId: dbUser.id, fileName, filePath: localPath, fileType } });

      // ── ZIP ──────────────────────────────────────────────────────
      if (ext === '.zip') {
        await bot.editMessageText(`📦 Extracting *${fileName}*...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

        const userDir = await getUserTempDir(userId);
        const extractDir = path.join(userDir, `zip_${Date.now()}`);
        await fs.ensureDir(extractDir);
        const manifest = await extractZip(localPath, extractDir);
        zipSessions.set(userId, { extractDir, manifest, originalName: fileName });

        await incrementStat(dbUser.id, 'totalZips');

        await bot.editMessageText(
          formatManifest(manifest) + `\n\n✅ *${fileName}* loaded! Choose an action:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
        );
        return;
      }

      // ── TEXT / CODE ──────────────────────────────────────────────
      if (['text', 'code'].includes(fileType)) {
        await bot.editMessageText(`📖 Reading *${fileName}*...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
        const content = await readTextFile(localPath);
        const userPrompt = msg.caption || 'Analyze this file. Summarize what it does, its structure, and any issues you notice.';

        await bot.editMessageText(`🤖 Analyzing *${fileName}* with Claude...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
        const response = await askClaudeWithContext(userId, content, userPrompt, dbUser);

        await incrementStat(dbUser.id, 'totalFiles');
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

        for (const chunk of splitIntoChunks(response)) {
          await bot.sendMessage(chatId, chunk);
        }
        await bot.sendMessage(chatId,
          `💡 Tell me what edits to make and I'll send back the updated file.`
        );
        return;
      }

      await bot.editMessageText(
        `📎 Received *${fileName}*.\n\nI can read: \`.txt .js .py .json .md .zip\` etc.\nFor images, just send them as photos!`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      );

    } catch (err) {
      logger.error(`fileHandler error for ${userId}: ${err.message}`);
      await bot.editMessageText(`❌ Error: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    }
  });

  // ── /pack ────────────────────────────────────────────────────────
  bot.onText(/\/pack/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const session = zipSessions.get(userId);
    if (!session) return bot.sendMessage(chatId, '📦 No active ZIP session. Send a ZIP file first.');
    const statusMsg = await bot.sendMessage(chatId, '📦 Packing ZIP...');
    try {
      const userDir = await getUserTempDir(userId);
      const outName = `modified_${session.originalName || 'project.zip'}`;
      const outPath = path.join(userDir, outName);
      const result = await packZip(session.extractDir, outPath);
      await bot.deleteMessage(chatId, statusMsg.message_id);
      await bot.sendDocument(chatId, result.path, {}, { filename: outName, contentType: 'application/zip' });
      await bot.sendMessage(chatId, `✅ ZIP ready (${result.sizeHuman}).`, { reply_markup: zipMainKeyboard() });
    } catch (err) {
      await bot.editMessageText(`❌ Pack failed: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
    }
  });

  // ── /files ───────────────────────────────────────────────────────
  bot.onText(/\/files/, async (msg) => {
    const chatId = msg.chat.id;
    const session = zipSessions.get(msg.from.id);
    if (!session) return bot.sendMessage(chatId, '📦 No active ZIP session.');
    session.manifest = buildManifest(session.extractDir);
    await bot.sendMessage(chatId, formatManifest(session.manifest), { parse_mode: 'Markdown', reply_markup: zipMainKeyboard() });
  });

  logger.info('File handler registered (v2)');
  return { zipSessions };
}

module.exports = { registerFileHandler, zipSessions };
