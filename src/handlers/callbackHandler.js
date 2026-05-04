// src/handlers/callbackHandler.js — v3
// Handles ALL inline keyboard button presses

const path = require('path');
const fs = require('fs-extra');
const { getOrCreateUser } = require('../services/userService');
const { askClaude, askClaudeRaw, setMode, resetSession } = require('../services/claudeService');
const { readFile, writeFile, packZip, buildManifest, formatManifest, buildProjectContext } = require('../services/zipService');
const { getUserProjects, getProject, deleteProject, saveProject, formatProjectList } = require('../services/projectService');
const { getGlobalStats, getUserStats, formatGlobalStats, formatUserStats, incrementStat } = require('../services/statsService');
const { listMemories, clearMemories } = require('../services/memoryService');
const { getUserTempDir, splitIntoChunks, cleanUserTempDir } = require('../utils/helpers');
const {
  zipMainKeyboard, fileBrowserKeyboard, fileActionKeyboard,
  diffApprovalKeyboard, modeKeyboard, projectListKeyboard,
  adminKeyboard, decodeFilePath, mainMenuKeyboard, memoryKeyboard,
} = require('../utils/keyboards');
const prisma = require('../utils/db');
const logger = require('../utils/logger');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Pending edit approvals: userId -> { relPath, newContent, oldContent }
const pendingEdits = new Map();
// Pending prompts: userId -> { type, ... }
const pendingPrompts = new Map();

// Helper: safe editMessageText — if content is same (400), just answer quietly
async function safeEdit(bot, chatId, msgId, text, opts = {}) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) {
      // Already showing the same content — silently ignore
      return;
    }
    throw err;
  }
}

function registerCallbackHandler(bot, zipSessions) {
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const msgId = query.message.message_id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);
    const dbUser = await getOrCreateUser({ from: query.from, chat: query.message.chat });
    const zipSession = zipSessions.get(userId);

    try {

      // ── NOOP (placeholder buttons) ─────────────────────────────
      if (data === 'noop') return;

      // ── MAIN MENU HOME ─────────────────────────────────────────
      if (data === 'menu:home') {
        const name = query.from.first_name || 'there';
        await safeEdit(bot, chatId, msgId,
          `👋 *Welcome back, ${name}!*\n\nSend a message, image, file, ZIP, or GitHub URL to get started! 🚀\n\nUse the buttons below to access all features:`,
          { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
        );
        return;
      }

      // ── MENU: MODE ─────────────────────────────────────────────
      if (data === 'menu:mode') {
        await safeEdit(bot, chatId, msgId,
          `🎛️ *Select AI Mode*\n\n` +
          `💬 *Chat* — General conversation\n` +
          `💻 *Code* — Expert programmer, production-ready code\n` +
          `🐛 *Debug* — Find & fix bugs, explain root causes\n` +
          `📖 *Explain* — Patient teacher, simple explanations\n\n` +
          `Current mode: *${dbUser.mode || 'chat'}*`,
          { parse_mode: 'Markdown', reply_markup: modeKeyboard(dbUser.mode || 'chat') }
        );
        return;
      }

      // ── MENU: PROJECTS ─────────────────────────────────────────
      if (data === 'menu:projects') {
        const projects = await getUserProjects(dbUser.id);
        await safeEdit(bot, chatId, msgId,
          formatProjectList(projects),
          { parse_mode: 'Markdown', reply_markup: projectListKeyboard(projects) }
        );
        return;
      }

      // ── MENU: MEMORY ───────────────────────────────────────────
      if (data === 'menu:memory') {
        const memories = await listMemories(dbUser.id);
        const text = memories.length
          ? `🧠 *What I remember about you:*\n\n` + memories.map((m) => `• *${m.key.replace(/_/g, ' ')}:* ${m.value}`).join('\n')
          : '🧠 No memories stored yet.\n\nI automatically learn facts from your conversations.';
        await safeEdit(bot, chatId, msgId, text, { parse_mode: 'Markdown', reply_markup: memoryKeyboard() });
        return;
      }

      // ── MENU: STATS ────────────────────────────────────────────
      if (data === 'menu:stats') {
        const stats = await getUserStats(dbUser.id);
        await safeEdit(bot, chatId, msgId,
          formatUserStats(stats, dbUser),
          { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
        );
        return;
      }

      // ── MENU: RESET ────────────────────────────────────────────
      if (data === 'menu:reset') {
        await resetSession(userId);
        await cleanUserTempDir(userId);
        await safeEdit(bot, chatId, msgId,
          '🔄 *Session reset!* Fresh start — send a message to begin.',
          { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
        );
        return;
      }

      // ── MENU: MYID ─────────────────────────────────────────────
      if (data === 'menu:myid') {
        await bot.sendMessage(chatId, `🆔 Your Telegram ID: \`${userId}\``, { parse_mode: 'Markdown' });
        return;
      }

      // ── MENU: CLEAR ────────────────────────────────────────────
      if (data === 'menu:clear') {
        await cleanUserTempDir(userId);
        await safeEdit(bot, chatId, msgId,
          '🗑️ Temp files cleared.',
          { reply_markup: mainMenuKeyboard() }
        );
        return;
      }

      // ── MODE SWITCH ────────────────────────────────────────────
      if (data.startsWith('mode:')) {
        const mode = data.split(':')[1];
        await setMode(userId, mode);
        dbUser.mode = mode;
        const modeNames = { chat: '💬 Chat', code: '💻 Code', debug: '🐛 Debug', explain: '📖 Explain' };
        await safeEdit(bot, chatId, msgId,
          `✅ Mode switched to *${modeNames[mode]}*\n\nAll future messages will use this mode.\n\nCurrent mode: *${mode}*`,
          { parse_mode: 'Markdown', reply_markup: modeKeyboard(mode) }
        );
        return;
      }

      // ── ZIP MENU ───────────────────────────────────────────────
      if (data === 'zip:menu') {
        if (!zipSession) return bot.sendMessage(chatId, '❌ No active ZIP session.', { reply_markup: mainMenuKeyboard() });
        await safeEdit(bot, chatId, msgId,
          formatManifest(zipSession.manifest) + '\n\nWhat would you like to do?',
          { parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
        );
        return;
      }

      // ── ZIP BROWSE (file tree) ─────────────────────────────────
      if (data.startsWith('zip:browse:')) {
        if (!zipSession) return bot.sendMessage(chatId, '❌ No active ZIP session.', { reply_markup: mainMenuKeyboard() });
        const page = parseInt(data.split(':')[2]) || 0;
        const manifest = buildManifest(zipSession.extractDir);
        zipSession.manifest = manifest;
        await safeEdit(bot, chatId, msgId,
          `📁 *File Browser* — ${manifest.length} files (page ${page + 1}):`,
          { parse_mode: 'Markdown', reply_markup: fileBrowserKeyboard(manifest, page) }
        );
        return;
      }

      // ── ZIP ANALYZE ────────────────────────────────────────────
      if (data === 'zip:analyze') {
        if (!zipSession) return bot.sendMessage(chatId, '❌ No active ZIP session.');
        await safeEdit(bot, chatId, msgId, '🔍 Analyzing your project...');
        const context = await buildProjectContext(zipSession.manifest, zipSession.extractDir);
        const response = await _askClaudeWithContext(userId, context, 'Analyze this project. Give a structured overview: purpose, architecture, key files, potential improvements.', dbUser);
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        for (const chunk of splitIntoChunks(response)) await bot.sendMessage(chatId, chunk);
        await bot.sendMessage(chatId, '📦 ZIP Menu:', { reply_markup: zipMainKeyboard() });
        return;
      }

      // ── ZIP PACK ───────────────────────────────────────────────
      if (data === 'zip:pack') {
        if (!zipSession) return bot.sendMessage(chatId, '❌ No active ZIP session.');
        await safeEdit(bot, chatId, msgId, '📦 Packing ZIP...');
        const userDir = await getUserTempDir(userId);
        const outName = `modified_${zipSession.originalName || 'project.zip'}`;
        const outPath = path.join(userDir, outName);
        const result = await packZip(zipSession.extractDir, outPath);
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        await bot.sendDocument(chatId, result.path, {}, { filename: outName, contentType: 'application/zip' });
        await bot.sendMessage(chatId, `✅ ZIP ready (${result.sizeHuman}).`, { reply_markup: zipMainKeyboard() });
        return;
      }

      // ── ZIP SAVE ───────────────────────────────────────────────
      if (data === 'zip:save_prompt') {
        pendingPrompts.set(userId, { type: 'save_project' });
        await bot.sendMessage(chatId, '💾 What do you want to name this project?');
        return;
      }

      // ── ZIP CLEAR ──────────────────────────────────────────────
      if (data === 'zip:clear') {
        zipSessions.delete(userId);
        await safeEdit(bot, chatId, msgId, '🗑️ ZIP session cleared.', { reply_markup: mainMenuKeyboard() });
        return;
      }

      // ── ZIP GEN FILE PROMPT ────────────────────────────────────
      if (data === 'zip:gen_prompt') {
        pendingPrompts.set(userId, { type: 'gen_file' });
        await bot.sendMessage(chatId, '💻 Describe the file to generate:\n\nFormat: `path/to/file.js — description`\nExample: `src/auth.js — JWT authentication middleware`', { parse_mode: 'Markdown' });
        return;
      }

      // ── FILE READ ──────────────────────────────────────────────
      if (data.startsWith('file:read:')) {
        if (!zipSession) return bot.sendMessage(chatId, '❌ No active ZIP session.');
        const relPath = decodeFilePath(data.replace('file:read:', ''));
        try {
          const { content, truncated } = await readFile(zipSession.extractDir, relPath);
          const header = `📄 *${relPath}*${truncated ? ' *(truncated)*' : ''}:\n\n`;
          await bot.sendMessage(chatId, header + `\`\`\`\n${content.slice(0, 3800)}\n\`\`\``, {
            parse_mode: 'Markdown',
            reply_markup: fileActionKeyboard(relPath),
          });
        } catch (err) {
          await bot.sendMessage(chatId, `❌ ${err.message}`);
        }
        return;
      }

      // ── FILE EDIT PROMPT ───────────────────────────────────────
      if (data.startsWith('file:edit_prompt:')) {
        const relPath = decodeFilePath(data.replace('file:edit_prompt:', ''));
        pendingPrompts.set(userId, { type: 'edit_file', relPath });
        await bot.sendMessage(chatId, `✏️ What changes do you want to make to *${relPath}*?\n\nDescribe the edit:`, { parse_mode: 'Markdown' });
        return;
      }

      // ── FILE APPROVE EDIT ──────────────────────────────────────
      if (data.startsWith('file:approve:')) {
        const relPath = decodeFilePath(data.replace('file:approve:', ''));
        const pending = pendingEdits.get(`${userId}:${relPath}`);
        if (!pending) return bot.sendMessage(chatId, '❌ No pending edit found.');
        await writeFile(zipSession.extractDir, relPath, pending.newContent);
        pendingEdits.delete(`${userId}:${relPath}`);
        await incrementStat(dbUser.id, 'totalEdits');
        await safeEdit(bot, chatId, msgId,
          `✅ Changes applied to *${relPath}*!`,
          { parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
        );
        return;
      }

      // ── FILE REJECT EDIT ───────────────────────────────────────
      if (data.startsWith('file:reject:')) {
        const relPath = decodeFilePath(data.replace('file:reject:', ''));
        pendingEdits.delete(`${userId}:${relPath}`);
        await safeEdit(bot, chatId, msgId, '❌ Edit rejected. Original file unchanged.', { reply_markup: zipMainKeyboard() });
        return;
      }

      // ── FILE DELETE ────────────────────────────────────────────
      if (data.startsWith('file:delete:')) {
        const relPath = decodeFilePath(data.replace('file:delete:', ''));
        if (!zipSession) return;
        const fullPath = path.join(zipSession.extractDir, relPath);
        await fs.remove(fullPath);
        zipSession.manifest = buildManifest(zipSession.extractDir);
        await safeEdit(bot, chatId, msgId,
          `🗑️ Deleted *${relPath}*`,
          { parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
        );
        return;
      }

      // ── PROJECT LOAD ───────────────────────────────────────────
      if (data.startsWith('project:load:')) {
        const id = parseInt(data.split(':')[2]);
        const project = await getProject(id, dbUser.id);
        if (!project) return bot.sendMessage(chatId, '❌ Project not found.');
        if (!await fs.pathExists(project.extractDir)) return bot.sendMessage(chatId, '❌ Project files no longer exist on disk. Please re-upload.');
        const manifest = buildManifest(project.extractDir);
        zipSessions.set(userId, { extractDir: project.extractDir, manifest, originalName: `${project.name}.zip` });
        await safeEdit(bot, chatId, msgId,
          `✅ Loaded project *${project.name}*\n\n` + formatManifest(manifest),
          { parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
        );
        return;
      }

      // ── PROJECT DELETE ─────────────────────────────────────────
      if (data.startsWith('project:delete:')) {
        const id = parseInt(data.split(':')[2]);
        await deleteProject(id, dbUser.id);
        const projects = await getUserProjects(dbUser.id);
        await safeEdit(bot, chatId, msgId,
          formatProjectList(projects),
          { parse_mode: 'Markdown', reply_markup: projectListKeyboard(projects) }
        );
        return;
      }

      // ── MEMORY LIST ────────────────────────────────────────────
      if (data === 'memory:list') {
        const memories = await listMemories(dbUser.id);
        const text = memories.length
          ? `🧠 *Your Memories:*\n\n` + memories.map((m) => `• *${m.key.replace(/_/g, ' ')}:* ${m.value}`).join('\n')
          : '🧠 No memories stored yet.';
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: memoryKeyboard() });
        return;
      }

      if (data === 'memory:clear_confirm') {
        await clearMemories(dbUser.id);
        await safeEdit(bot, chatId, msgId, '🗑️ All memories cleared.', { reply_markup: mainMenuKeyboard() });
        return;
      }

      // ── ADMIN ──────────────────────────────────────────────────
      if (data.startsWith('admin:')) {
        if (String(userId) !== String(ADMIN_CHAT_ID)) return bot.sendMessage(chatId, '🚫 Admin only.');

        if (data === 'admin:stats') {
          const stats = await getGlobalStats();
          await bot.sendMessage(chatId, formatGlobalStats(stats), { parse_mode: 'Markdown' });
          return;
        }

        if (data === 'admin:users') {
          const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
          const text = users.map((u) => `• ${u.firstName || '?'} (@${u.username || '—'}) \`${u.telegramId}\` ${u.isBanned ? '🚫' : '✅'}`).join('\n');
          await bot.sendMessage(chatId, `👥 *Users (${users.length}):*\n\n${text}`, { parse_mode: 'Markdown' });
          return;
        }

        if (data === 'admin:broadcast_prompt') {
          pendingPrompts.set(userId, { type: 'broadcast' });
          await bot.sendMessage(chatId, '📢 Type your broadcast message:');
          return;
        }

        if (data === 'admin:cleanup') {
          const { TEMP_DIR } = require('../utils/helpers');
          const dirs = await fs.readdir(TEMP_DIR).catch(() => []);
          let cleaned = 0;
          for (const dir of dirs) {
            const fullPath = path.join(TEMP_DIR, dir);
            const stat = await fs.stat(fullPath).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
              await fs.remove(fullPath);
              cleaned++;
            }
          }
          await bot.sendMessage(chatId, `🗑️ Cleaned ${cleaned} old temp directories.`);
          return;
        }
      }

    } catch (err) {
      logger.error(`Callback error [${data}] for user ${userId}: ${err.message}`);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`).catch(() => {});
    }
  });

  logger.info('Callback handler registered (v3)');
  return { pendingEdits, pendingPrompts };
}

// Local helper to avoid circular require
async function _askClaudeWithContext(telegramId, context, instruction, dbUser) {
  const { askClaudeWithContext } = require('../services/claudeService');
  return askClaudeWithContext(telegramId, context, instruction, dbUser);
}

module.exports = { registerCallbackHandler, pendingEdits: new Map(), pendingPrompts: new Map() };
