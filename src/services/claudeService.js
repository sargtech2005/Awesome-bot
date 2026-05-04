// src/services/claudeService.js — v5
// Omega API: GET https://...Claude-pro?prompt=...&sessionId=...
// Response:  { success, sessionId, response, history, source, timestamp }

const axios = require('axios');
const logger = require('../utils/logger');
const prisma = require('../utils/db');
const { getUserMemoryContext } = require('./memoryService');

const OMEGA_BASE = process.env.CLAUDE_API_BASE || 'https://my-api-rzmb.onrender.com/api/ai/Claude-pro';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_HISTORY = 30;

const MODE_PREFIXES = {
  chat:    '',
  code:    '[CODE MODE] You are an expert programmer. Write clean, well-commented, production-ready code and always explain it.\n\n',
  debug:   '[DEBUG MODE] You are a debugging expert. Identify bugs, explain root causes, and provide fixed code.\n\n',
  explain: '[EXPLAIN MODE] You are a patient teacher. Explain everything simply with examples. Define all jargon.\n\n',
};

// ─── FREE FALLBACK APIS ────────────────────────────────────────────────────────
// Only used if BOTH Anthropic key AND Omega proxy fail
const FREE_APIS = [
  {
    name: 'Pollinations-Mistral',
    async call(prompt) {
      const { data } = await axios.post(
        'https://text.pollinations.ai/',
        { messages: [{ role: 'user', content: prompt }], model: 'mistral' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const text = typeof data === 'string' ? data : data?.text;
      if (text && text.trim()) return text.trim();
      throw new Error('Empty');
    },
  },
  {
    name: 'Pollinations-OpenAI',
    async call(prompt) {
      const { data } = await axios.post(
        'https://text.pollinations.ai/',
        { messages: [{ role: 'user', content: prompt }], model: 'openai' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const text = typeof data === 'string' ? data : data?.text;
      if (text && text.trim()) return text.trim();
      throw new Error('Empty');
    },
  },
  {
    name: 'OpenRouter-Free',
    async call(prompt) {
      const { data } = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'mistralai/mistral-7b-instruct:free', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 },
        { headers: { 'Content-Type': 'application/json', 'HTTP-Referer': 'https://t.me', 'X-Title': 'DAwesome-Bot' }, timeout: 35000 }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return text.trim();
      throw new Error('No content');
    },
  },
  {
    name: 'Groq-Llama3',
    async call(prompt) {
      if (!process.env.GROQ_API_KEY) throw new Error('No GROQ_API_KEY');
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama3-8b-8192', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return text.trim();
      throw new Error('No content');
    },
  },
  {
    name: 'Together-Llama',
    async call(prompt) {
      if (!process.env.TOGETHER_API_KEY) throw new Error('No TOGETHER_API_KEY');
      const { data } = await axios.post(
        'https://api.together.xyz/v1/chat/completions',
        { model: 'meta-llama/Llama-3-8b-chat-hf', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 },
        { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return text.trim();
      throw new Error('No content');
    },
  },
];

async function _askFreeApis(prompt) {
  for (const api of FREE_APIS) {
    try {
      logger.info(`Free fallback: ${api.name}`);
      return await api.call(prompt);
    } catch (e) {
      logger.warn(`Free fallback ${api.name} failed: ${e.message}`);
    }
  }
  throw new Error('All AI APIs exhausted. Please try again later.');
}

// ─── OMEGA PROXY — exact format confirmed ─────────────────────────────────────
// GET ?prompt=<text>&sessionId=<id>
// Returns { success, sessionId, response, history, source, timestamp }
async function _askOmega(prompt, sessionId) {
  const params = new URLSearchParams({ prompt });
  if (sessionId) params.append('sessionId', sessionId);

  const url = `${OMEGA_BASE}?${params.toString()}`;
  logger.info(`Omega GET: ${url.slice(0, 120)}`);

  const { data } = await axios.get(url, { timeout: 90000 });

  if (!data.success) throw new Error(`Omega returned success=false: ${JSON.stringify(data).slice(0, 100)}`);
  if (!data.response) throw new Error('Omega returned empty response field');

  return {
    text: data.response,
    sessionId: data.sessionId || sessionId,
  };
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function saveSessionId(telegramId, sessionId) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { sessionId } });
}

async function saveMessage(userId, role, content, mode = 'chat') {
  await prisma.message.create({ data: { userId, role, content, mode } });
  // Trim history
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

// ─── PUBLIC: askClaude ────────────────────────────────────────────────────────
// Priority: 1) Anthropic direct  2) Omega proxy  3) Free APIs
async function askClaude(telegramId, prompt, dbUser) {
  const mode       = dbUser.mode || 'chat';
  const modePrefix = MODE_PREFIXES[mode] || '';
  const memCtx     = await getUserMemoryContext(dbUser.id);

  // Mode prefix + memory only prepended once, not stored in session history
  const fullPrompt = `${modePrefix}${memCtx}${prompt}`;

  let responseText = null;

  // ── 1. Anthropic direct ───────────────────────────────────────
  if (ANTHROPIC_API_KEY) {
    try {
      logger.info(`Anthropic direct | user=${telegramId} mode=${mode}`);
      const { data } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: ANTHROPIC_MODEL, max_tokens: 4096, messages: [{ role: 'user', content: fullPrompt }] },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 120000,
        }
      );
      responseText = data.content?.[0]?.text || null;
      if (responseText) logger.info(`Anthropic OK for ${telegramId}`);
    } catch (e) {
      logger.warn(`Anthropic failed: ${e.message}`);
    }
  }

  // ── 2. Omega proxy ────────────────────────────────────────────
  if (!responseText) {
    try {
      logger.info(`Omega proxy | user=${telegramId} sessionId=${dbUser.sessionId || 'new'}`);
      const result = await _askOmega(fullPrompt, dbUser.sessionId);
      responseText = result.text;

      // Persist the sessionId so follow-up messages continue the same conversation
      if (result.sessionId && result.sessionId !== dbUser.sessionId) {
        await saveSessionId(telegramId, result.sessionId);
        dbUser.sessionId = result.sessionId;
        logger.info(`Saved new sessionId ${result.sessionId} for ${telegramId}`);
      }
    } catch (e) {
      logger.warn(`Omega failed: ${e.message}`);
    }
  }

  // ── 3. Free fallback APIs ─────────────────────────────────────
  if (!responseText) {
    logger.warn(`All primary APIs failed for ${telegramId} — trying free fallbacks`);
    responseText = await _askFreeApis(fullPrompt);
  }

  // Save to DB
  await saveMessage(dbUser.id, 'user', prompt, mode);
  await saveMessage(dbUser.id, 'assistant', responseText, mode);
  await incrementMessages(dbUser.id);

  return responseText;
}

// ─── PUBLIC: askClaudeStream ──────────────────────────────────────────────────
// Streams from Anthropic if key available, else falls back to askClaude
async function askClaudeStream(telegramId, prompt, dbUser, onChunk) {
  if (!ANTHROPIC_API_KEY) {
    const text = await askClaude(telegramId, prompt, dbUser);
    onChunk(text);
    return text;
  }

  const mode       = dbUser.mode || 'chat';
  const modePrefix = MODE_PREFIXES[mode] || '';
  const memCtx     = await getUserMemoryContext(dbUser.id);
  const fullPrompt = `${modePrefix}${memCtx}${prompt}`;

  let httpRes;
  try {
    logger.info(`Claude stream | user=${telegramId} mode=${mode}`);
    httpRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: ANTHROPIC_MODEL, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: fullPrompt }] },
      {
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        responseType: 'stream',
        timeout: 120000,
      }
    );
  } catch (e) {
    logger.warn(`Stream init failed, fallback: ${e.message}`);
    const text = await askClaude(telegramId, prompt, dbUser);
    onChunk(text);
    return text;
  }

  return new Promise((resolve, reject) => {
    let fullText = '';
    let buffer   = '';

    httpRes.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const delta = evt.delta.text || '';
            fullText += delta;
            onChunk(delta);
          }
        } catch (_) {}
      }
    });

    httpRes.data.on('end', async () => {
      try {
        await saveMessage(dbUser.id, 'user', prompt, mode);
        await saveMessage(dbUser.id, 'assistant', fullText, mode);
        await incrementMessages(dbUser.id);
      } catch (_) {}
      resolve(fullText);
    });

    httpRes.data.on('error', async (e) => {
      logger.warn(`Stream error, fallback: ${e.message}`);
      try {
        const text = await askClaude(telegramId, prompt, dbUser);
        onChunk(text);
        resolve(text);
      } catch (err) { reject(err); }
    });
  });
}

// ─── PUBLIC: askClaudeWithContext ─────────────────────────────────────────────
async function askClaudeWithContext(telegramId, fileContext, instruction, dbUser) {
  return askClaude(telegramId, `${instruction}\n\n--- FILE CONTENT ---\n${fileContext}\n--- END ---`, dbUser);
}

// ─── PUBLIC: askClaudeRaw ────────────────────────────────────────────────────
// For internal calls (memory extraction) — short, no DB save
async function askClaudeRaw(prompt) {
  if (ANTHROPIC_API_KEY) {
    try {
      const { data } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: ANTHROPIC_MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
      );
      return data.content?.[0]?.text || '';
    } catch (_) {}
  }
  try {
    const result = await _askOmega(prompt, null);
    return result.text;
  } catch (_) {}
  return await _askFreeApis(prompt);
}

// ─── PUBLIC: resetSession ────────────────────────────────────────────────────
async function resetSession(telegramId) {
  // Clear sessionId so next message starts a fresh Omega session
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { sessionId: null } });
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (user) await prisma.message.deleteMany({ where: { userId: user.id } });
}

// ─── PUBLIC: setMode ─────────────────────────────────────────────────────────
async function setMode(telegramId, mode) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { mode } });
}

module.exports = {
  askClaude, askClaudeStream, askClaudeWithContext, askClaudeRaw,
  resetSession, setMode, saveMessage,
};
