// src/handlers/messageHandler.js — v2
// Routes text messages: GitHub clone, zip ops, pending prompts, code gen, chat

const path = require('path');
const fs = require('fs-extra');
const { getOrCreateUser, isUserBanned } = require('../services/userService');
const { askClaude, askClaudeWithContext, askClaudeRaw } = require('../services/claudeService');
const { readFile, writeFile, packZip, buildProjectContext, buildManifest, formatManifest } = require('../services/zipService');
const { cloneRepo, isGitHubUrl, extractRepoName } = require('../services/githubService');
const { saveProject, getUserProjects, formatProjectList } = require('../services/projectService');
const { incrementStat } = require('../services/statsService');
const { extractAndSaveMemory } = require('../services/memoryService');
const { getUserTempDir, splitIntoChunks, uniqueFilename } = require('../utils/helpers');
const { rateLimiter } = require('../middleware/rateLimiter');
const { zipMainKeyboard, projectListKeyboard, diffApprovalKeyboard, encodeFilePath, decodeFilePath } = require('../utils/keyboards');
const logger = require('../utils/logger');

// These are shared with callbackHandler
let zipSessions;
let pendingEdits;
let pendingPrompts;

function registerMessageHandler(bot, zipSessionStore, pendingEditsStore, pendingPromptsStore) {
  zipSessions = zipSessionStore;
  pendingEdits = pendingEditsStore;
  pendingPrompts = pendingPromptsStore;

  bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();

    if (await isUserBanned(userId)) return bot.sendMessage(chatId, '🚫 You are banned.');

    const { allowed, waitSec } = rateLimiter(userId);
    if (!allowed) return bot.sendMessage(chatId, `⏳ Slow down! Wait ${waitSec}s.`);

    const dbUser = await getOrCreateUser(msg);
    const zipSession = zipSessions.get(userId);

    await bot.sendChatAction(chatId, 'typing');

    try {
      // ── PENDING PROMPTS (from inline keyboards) ──────────────────
      const pending = pendingPrompts.get(userId);
      if (pending) {
        pendingPrompts.delete(userId);

        if (pending.type === 'save_project' && zipSession) {
          const project = await saveProject(dbUser.id, userId, text, zipSession.extractDir, {
            originalZip: zipSession.originalName,
            fileCount: zipSession.manifest?.length || 0,
          });
          await bot.sendMessage(chatId, `💾 Project *"${text}"* saved! Use /projects to reload it.`, { parse_mode: 'Markdown' });
          return;
        }

        if (pending.type === 'broadcast') {
          const { getAllUsers } = require('../services/userService');
          const prisma = require('../utils/db');
          const users = await getAllUsers();
          let sent = 0;
          for (const user of users) {
            try {
              await bot.sendMessage(String(user.telegramId), `📢 *Announcement:*\n\n${text}`, { parse_mode: 'Markdown' });
              sent++;
              await new Promise(r => setTimeout(r, 50));
            } catch (_) {}
          }
          await prisma.broadcastLog.create({ data: { message: text, sentTo: sent, sentBy: BigInt(userId) } });
          await bot.sendMessage(chatId, `📢 Broadcast sent to ${sent}/${users.length} users.`);
          return;
        }

        if (pending.type === 'edit_file' && zipSession) {
          return await handleZipEditWithDiff(bot, chatId, userId, zipSession, pending.relPath, text, dbUser);
        }

        if (pending.type === 'gen_file' && zipSession) {
          const genMatch = text.match(/^(.+?)\s*[—\-–]\s*(.+)/s);
          if (genMatch) {
            return await handleZipGenerate(bot, chatId, userId, zipSession, genMatch[1].trim(), genMatch[2].trim(), dbUser);
          }
          return bot.sendMessage(chatId, '❌ Format: `path/to/file.js — description`', { parse_mode: 'Markdown' });
        }
      }

      // ── GITHUB URL ───────────────────────────────────────────────
      if (isGitHubUrl(text)) {
        return await handleGitHubClone(bot, chatId, userId, text, dbUser);
      }

      // ── ZIP SESSION COMMANDS (text shortcuts) ────────────────────
      if (zipSession) {
        const readMatch = text.match(/^read\s+(.+)/i);
        if (readMatch) return await handleZipRead(bot, chatId, userId, zipSession, readMatch[1].trim());

        const editMatch = text.match(/^edit\s+(.+?)\s*[—\-–]{1,2}\s*(.+)/is);
        if (editMatch) return await handleZipEditWithDiff(bot, chatId, userId, zipSession, editMatch[1].trim(), editMatch[2].trim(), dbUser);

        const genMatch = text.match(/^generate\s+(?:a?\s*)?(?:new\s+)?file\s+(\S+)\s+(?:that\s+)?(.+)/is);
        if (genMatch) return await handleZipGenerate(bot, chatId, userId, zipSession, genMatch[1].trim(), genMatch[2].trim(), dbUser);

        if (/^(analyze|explain|review|audit|summarize)\b/i.test(text)) {
          return await handleZipAnalyze(bot, chatId, userId, zipSession, text, dbUser);
        }
      }

      // ── CODE GENERATION → ZIP ────────────────────────────────────
      if (/\b(generate|create|write|build|make)\b.+(zip|send.*file|download)/i.test(text)) {
        return await handleCodeGenAndZip(bot, chatId, userId, text, dbUser);
      }

      // ── PLAIN CLAUDE CHAT ────────────────────────────────────────
      const statusMsg = await bot.sendMessage(chatId, '🤖 Thinking...');
      const response = await askClaude(userId, text, dbUser);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      // Extract and save memories
      await extractAndSaveMemory(userId, dbUser.id, text);

      for (const chunk of splitIntoChunks(response)) {
        await bot.sendMessage(chatId, chunk);
      }

    } catch (err) {
      logger.error(`messageHandler error for ${userId}: ${err.message}`);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nTry /reset if this keeps happening.`);
    }
  });

  logger.info('Message handler registered (v2)');
}

// ── GITHUB CLONE ───────────────────────────────────────────────────────────────
async function handleGitHubClone(bot, chatId, userId, url, dbUser) {
  const statusMsg = await bot.sendMessage(chatId, `🐙 Cloning GitHub repo...\n\`${url}\``, { parse_mode: 'Markdown' });
  try {
    const result = await cloneRepo(userId, url);
    zipSessions.set(userId, {
      extractDir: result.extractDir,
      manifest: result.manifest,
      originalName: `${result.repoName}.zip`,
    });

    await incrementStat(dbUser.id, 'totalZips');

    await bot.editMessageText(
      `✅ *${result.repoName}* cloned!\n${result.fileCount} files • ${result.totalSizeHuman}\n\n` +
      formatManifest(result.manifest),
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
    );
  } catch (err) {
    logger.error(`GitHub clone error: ${err.message}`);
    await bot.editMessageText(`❌ Clone failed: ${err.message}\n\nMake sure it's a public repo URL.`, {
      chat_id: chatId, message_id: statusMsg.message_id,
    });
  }
}

// ── ZIP READ ───────────────────────────────────────────────────────────────────
async function handleZipRead(bot, chatId, userId, session, relPath) {
  try {
    const { content, truncated } = await readFile(session.extractDir, relPath);
    const header = `📄 *${relPath}*${truncated ? ' *(truncated)*' : ''}:\n\n`;
    const body = `\`\`\`\n${content.slice(0, 3800)}\n\`\`\``;
    await bot.sendMessage(chatId, header + body, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ── ZIP EDIT WITH DIFF ─────────────────────────────────────────────────────────
async function handleZipEditWithDiff(bot, chatId, userId, session, relPath, instruction, dbUser) {
  const statusMsg = await bot.sendMessage(chatId, `✏️ Editing *${relPath}*...`, { parse_mode: 'Markdown' });
  try {
    const { content: oldContent } = await readFile(session.extractDir, relPath);

    const prompt = `Edit the following file.\nFile: ${relPath}\nInstruction: ${instruction}\n\nCurrent content:\n\`\`\`\n${oldContent}\n\`\`\`\n\nReturn ONLY the complete updated file content. No markdown fences, no explanation.`;

    await bot.editMessageText(`🤖 Claude is editing *${relPath}*...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

    const newContent = await askClaude(userId, prompt, dbUser);
    const clean = newContent.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');

    // Store pending edit for approval
    pendingEdits.set(`${userId}:${relPath}`, { relPath, newContent: clean, oldContent });

    // Generate a brief diff summary
    const oldLines = oldContent.split('\n').length;
    const newLines = clean.split('\n').length;
    const diff = newLines - oldLines;
    const diffStr = diff > 0 ? `+${diff} lines` : diff < 0 ? `${diff} lines` : 'same length';

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId,
      `✏️ *Edit ready for ${relPath}*\n\n` +
      `📊 Changes: ${diffStr} (${oldLines} → ${newLines} lines)\n\n` +
      `*Preview (first 20 lines of new version):*\n\`\`\`\n${clean.split('\n').slice(0, 20).join('\n')}\n\`\`\`\n\nApply changes?`,
      { parse_mode: 'Markdown', reply_markup: diffApprovalKeyboard(relPath) }
    );

    await incrementStat(dbUser.id, 'totalEdits');
  } catch (err) {
    logger.error(`ZIP edit error: ${err.message}`);
    await bot.editMessageText(`❌ Edit failed: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

// ── ZIP GENERATE FILE ──────────────────────────────────────────────────────────
async function handleZipGenerate(bot, chatId, userId, session, relPath, description, dbUser) {
  const statusMsg = await bot.sendMessage(chatId, `💻 Generating *${relPath}*...`, { parse_mode: 'Markdown' });
  try {
    const prompt = `Generate the complete content for a new file.\nFile path: ${relPath}\nDescription: ${description}\n\nReturn ONLY the raw file content. No markdown, no fences, no explanation.`;
    const content = await askClaude(userId, prompt, dbUser);
    const clean = content.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    await writeFile(session.extractDir, relPath, clean);
    session.manifest = buildManifest(session.extractDir);
    await incrementStat(dbUser.id, 'totalCodeGens');
    await bot.editMessageText(
      `✅ Created *${relPath}*!\n\nUse the menu to browse or download.`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown', reply_markup: zipMainKeyboard() }
    );
  } catch (err) {
    await bot.editMessageText(`❌ Generate failed: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

// ── ZIP ANALYZE ────────────────────────────────────────────────────────────────
async function handleZipAnalyze(bot, chatId, userId, session, instruction, dbUser) {
  const statusMsg = await bot.sendMessage(chatId, `🔍 Analyzing project...`);
  try {
    const context = await buildProjectContext(session.manifest, session.extractDir);
    const response = await askClaudeWithContext(userId, context, instruction, dbUser);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    for (const chunk of splitIntoChunks(response)) await bot.sendMessage(chatId, chunk);
    await bot.sendMessage(chatId, '📦 ZIP Menu:', { reply_markup: zipMainKeyboard() });
  } catch (err) {
    await bot.editMessageText(`❌ Analysis failed: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

// ── CODE GEN → ZIP ─────────────────────────────────────────────────────────────
async function handleCodeGenAndZip(bot, chatId, userId, instruction, dbUser) {
  const statusMsg = await bot.sendMessage(chatId, `💻 Generating project...`);
  try {
    const prompt = `${instruction}\n\nRespond with a JSON object where keys are file paths and values are file contents. Example: {"src/index.js": "...", "package.json": "..."}. Return ONLY valid JSON, no markdown, no explanation.`;
    const response = await askClaude(userId, prompt, dbUser);

    let files;
    try {
      const clean = response.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      files = JSON.parse(clean);
    } catch (_) {
      files = { 'output.txt': response };
    }

    const userDir = await getUserTempDir(userId);
    const projectDir = path.join(userDir, `gen_${Date.now()}`);
    await fs.ensureDir(projectDir);
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(projectDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content, 'utf8');
    }

    const zipPath = path.join(userDir, `generated_${Date.now()}.zip`);
    const result = await packZip(projectDir, zipPath);

    await incrementStat(dbUser.id, 'totalCodeGens');
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendDocument(chatId, result.path, {}, { filename: 'generated_project.zip', contentType: 'application/zip' });
    await bot.sendMessage(chatId, `✅ Generated ${Object.keys(files).length} file(s) (${result.sizeHuman}).`);

    await fs.remove(projectDir);
  } catch (err) {
    logger.error(`Code gen error: ${err.message}`);
    await bot.editMessageText(`❌ Code generation failed: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

module.exports = { registerMessageHandler };
