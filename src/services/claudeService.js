// src/services/claudeService.js — v2

const axios = require('axios');
const logger = require('../utils/logger');
const prisma = require('../utils/db');
const { getUserMemoryContext } = require('./memoryService');

const BASE_URL = process.env.CLAUDE_API_BASE || 'https://my-api-rzmb.onrender.com/api/ai/Claude-pro';
const MAX_HISTORY = 30;

const MODE_PREFIXES = {
  chat: '',
  code: '[MODE: Code Assistant] You are an expert programmer. Focus on clean, well-commented, production-ready code. Always explain what the code does.\n\n',
  debug: '[MODE: Debugger] You are a debugging expert. Identify bugs, explain root causes, and provide fixed code.\n\n',
  explain: '[MODE: Teacher] You are a patient teacher. Explain everything simply with examples. Define jargon.\n\n',
};

async function saveSessionId(telegramId, sessionId) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { sessionId } });
}

async function saveMessage(userId, role, content, mode = 'chat') {
  await prisma.message.create({ data: { userId, role, content, mode } });
  const old = await prisma.message.findMany({
    where: { userId }, orderBy: { createdAt: 'desc' }, skip: MAX_HISTORY, select: { id: true },
  });
  if (old.length) await prisma.message.deleteMany({ where: { id: { in: old.map((m) => m.id) } } });
}

async function incrementMessages(dbUserId) {
  await prisma.userStats.upsert({
    where: { userId: dbUserId },
    update: { totalMessages: { increment: 1 }, lastActiveAt: new Date() },
    create: { userId: dbUserId, totalMessages: 1, lastActiveAt: new Date() },
  });
}

async function askClaude(telegramId, prompt, dbUser) {
  const mode = dbUser.mode || 'chat';
  const modePrefix = MODE_PREFIXES[mode] || '';
  const memoryContext = await getUserMemoryContext(dbUser.id);
  const fullPrompt = `${modePrefix}${memoryContext}${prompt}`;

  try {
    const params = new URLSearchParams({ prompt: fullPrompt });
    if (dbUser.sessionId) params.append('sessionId', dbUser.sessionId);
    const url = `${BASE_URL}?${params.toString()}`;
    logger.info(`Claude API | user=${telegramId} | mode=${mode}`);

    const { data } = await axios.get(url, { timeout: 90000 });
    if (!data.success) throw new Error('API returned success=false');

    if (data.sessionId && data.sessionId !== dbUser.sessionId) {
      await saveSessionId(telegramId, data.sessionId);
      dbUser.sessionId = data.sessionId;
    }

    await saveMessage(dbUser.id, 'user', prompt, mode);
    await saveMessage(dbUser.id, 'assistant', data.response, mode);
    await incrementMessages(dbUser.id);
    return data.response;
  } catch (err) {
    logger.error(`Claude API error for ${telegramId}: ${err.message}`);
    throw err;
  }
}

async function askClaudeWithContext(telegramId, fileContext, userInstruction, dbUser) {
  const combined = `${userInstruction}\n\n--- FILE CONTENT ---\n${fileContext}\n--- END ---`;
  return askClaude(telegramId, combined, dbUser);
}

async function askClaudeRaw(prompt) {
  const params = new URLSearchParams({ prompt });
  const { data } = await axios.get(`${BASE_URL}?${params.toString()}`, { timeout: 60000 });
  if (!data.success) throw new Error('API error');
  return data.response;
}

async function resetSession(telegramId) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { sessionId: null } });
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (user) await prisma.message.deleteMany({ where: { userId: user.id } });
}

async function setMode(telegramId, mode) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { mode } });
}

module.exports = { askClaude, askClaudeWithContext, askClaudeRaw, resetSession, setMode, saveMessage };
