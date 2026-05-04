// src/services/claudeService.js — v2 + streaming + multi-fallback

const axios = require('axios');
const logger = require('../utils/logger');
const prisma = require('../utils/db');
const { getUserMemoryContext } = require('./memoryService');

const BASE_URL = process.env.CLAUDE_API_BASE || 'https://my-api-rzmb.onrender.com/api/ai/Claude-pro';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_HISTORY = 30;

const MODE_PREFIXES = {
  chat: '',
  code: '[MODE: Code Assistant] You are an expert programmer. Focus on clean, well-commented, production-ready code. Always explain what the code does.\n\n',
  debug: '[MODE: Debugger] You are a debugging expert. Identify bugs, explain root causes, and provide fixed code.\n\n',
  explain: '[MODE: Teacher] You are a patient teacher. Explain everything simply with examples. Define jargon.\n\n',
};

// ── 5 Free public AI fallback APIs (no key needed) ────────────────────────────
const FREE_APIS = [
  {
    name: 'Pollinations-Mistral',
    async call(prompt) {
      const { data } = await axios.post(
        'https://text.pollinations.ai/',
        { messages: [{ role: 'user', content: prompt }], model: 'mistral', seed: 42, jsonMode: false },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      if (typeof data === 'string' && data.length > 0) return data;
      throw new Error('Empty response from Pollinations');
    },
  },
  {
    name: 'Pollinations-OpenAI',
    async call(prompt) {
      const { data } = await axios.post(
        'https://text.pollinations.ai/',
        { messages: [{ role: 'user', content: prompt }], model: 'openai', seed: 42 },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      if (typeof data === 'string' && data.length > 0) return data;
      throw new Error('Empty response from Pollinations OpenAI');
    },
  },
  {
    name: 'Open-Mistral (openrouter-free)',
    async call(prompt) {
      const { data } = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'mistralai/mistral-7b-instruct:free',
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: { 'Content-Type': 'application/json', 'HTTP-Referer': 'https://t.me', 'X-Title': 'DAwesome Bot' },
          timeout: 60000,
        }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (text) return text;
      throw new Error('No content from OpenRouter free');
    },
  },
  {
    name: 'Groq-Llama3 (free tier)',
    async call(prompt) {
      const GROQ_KEY = process.env.GROQ_API_KEY; // optional, works if set
      if (!GROQ_KEY) throw new Error('No GROQ_API_KEY');
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama3-8b-8192', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 },
        { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (text) return text;
      throw new Error('No content from Groq');
    },
  },
  {
    name: 'Huggingface-Zephyr',
    async call(prompt) {
      const HF_KEY = process.env.HF_API_KEY; // optional
      const headers = { 'Content-Type': 'application/json' };
      if (HF_KEY) headers['Authorization'] = `Bearer ${HF_KEY}`;
      const { data } = await axios.post(
        'https://api-inference.huggingface.co/models/HuggingFaceH4/zephyr-7b-beta',
        { inputs: prompt, parameters: { max_new_tokens: 1024, return_full_text: false } },
        { headers, timeout: 60000 }
      );
      const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
      if (text && text.trim()) return text.trim();
      throw new Error('No content from HuggingFace');
    },
  },
];

async function _askFreeApiFallback(prompt) {
  for (const api of FREE_APIS) {
    try {
      logger.info(`Trying free fallback API: ${api.name}`);
      const result = await api.call(prompt);
      logger.info(`Free fallback success: ${api.name}`);
      return result;
    } catch (err) {
      logger.warn(`Free fallback ${api.name} failed: ${err.message}`);
    }
  }
  throw new Error('All AI APIs failed (primary + 5 fallbacks). Please try again later.');
}

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

// ── Non-streaming ask ──────────────────────────────────────────────────────────
async function askClaude(telegramId, prompt, dbUser) {
  const mode = dbUser.mode || 'chat';
  const modePrefix = MODE_PREFIXES[mode] || '';
  const memoryContext = await getUserMemoryContext(dbUser.id);
  const fullPrompt = `${modePrefix}${memoryContext}${prompt}`;

  if (ANTHROPIC_API_KEY) {
    try {
      return await _askAnthropicDirect(telegramId, fullPrompt, dbUser, mode, prompt);
    } catch (err) {
      logger.warn(`Anthropic API failed, trying proxy: ${err.message}`);
    }
  }

  try {
    return await _askProxy(telegramId, fullPrompt, dbUser, mode, prompt);
  } catch (err) {
    logger.warn(`Proxy API failed, trying free fallbacks: ${err.message}`);
    const response = await _askFreeApiFallback(fullPrompt);
    await saveMessage(dbUser.id, 'user', prompt, mode);
    await saveMessage(dbUser.id, 'assistant', response, mode);
    await incrementMessages(dbUser.id);
    return response;
  }
}

async function _askProxy(telegramId, fullPrompt, dbUser, mode, rawPrompt) {
  const params = new URLSearchParams({ prompt: fullPrompt });
  if (dbUser.sessionId) params.append('sessionId', dbUser.sessionId);
  const url = `${BASE_URL}?${params.toString()}`;
  logger.info(`Claude proxy | user=${telegramId} | mode=${mode}`);
  const { data } = await axios.get(url, { timeout: 90000 });
  if (!data.success) throw new Error('API returned success=false');
  if (data.sessionId && data.sessionId !== dbUser.sessionId) {
    await saveSessionId(telegramId, data.sessionId);
    dbUser.sessionId = data.sessionId;
  }
  await saveMessage(dbUser.id, 'user', rawPrompt, mode);
  await saveMessage(dbUser.id, 'assistant', data.response, mode);
  await incrementMessages(dbUser.id);
  return data.response;
}

async function _askAnthropicDirect(telegramId, fullPrompt, dbUser, mode, rawPrompt) {
  logger.info(`Claude direct | user=${telegramId} | mode=${mode}`);
  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: ANTHROPIC_MODEL, max_tokens: 4096, messages: [{ role: 'user', content: fullPrompt }] },
    {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 120000,
    }
  );
  const response = data.content?.[0]?.text || '';
  await saveMessage(dbUser.id, 'user', rawPrompt, mode);
  await saveMessage(dbUser.id, 'assistant', response, mode);
  await incrementMessages(dbUser.id);
  return response;
}

// ── Streaming ask ─────────────────────────────────────────────────────────────
async function askClaudeStream(telegramId, prompt, dbUser, onChunk) {
  if (!ANTHROPIC_API_KEY) {
    // Fall back to non-streaming (proxy or free APIs)
    const response = await askClaude(telegramId, prompt, dbUser);
    onChunk(response);
    return response;
  }

  const mode = dbUser.mode || 'chat';
  const modePrefix = MODE_PREFIXES[mode] || '';
  const memoryContext = await getUserMemoryContext(dbUser.id);
  const fullPrompt = `${modePrefix}${memoryContext}${prompt}`;

  logger.info(`Claude stream | user=${telegramId} | mode=${mode}`);

  let httpResponse;
  try {
    httpResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: ANTHROPIC_MODEL, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: fullPrompt }] },
      {
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        responseType: 'stream',
        timeout: 120000,
      }
    );
  } catch (err) {
    logger.warn(`Streaming failed, falling back to non-stream: ${err.message}`);
    const response = await askClaude(telegramId, prompt, dbUser);
    onChunk(response);
    return response;
  }

  return new Promise((resolve, reject) => {
    let fullText = '';
    let buffer = '';

    httpResponse.data.on('data', (chunk) => {
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

    httpResponse.data.on('end', async () => {
      try {
        await saveMessage(dbUser.id, 'user', prompt, mode);
        await saveMessage(dbUser.id, 'assistant', fullText, mode);
        await incrementMessages(dbUser.id);
      } catch (_) {}
      resolve(fullText);
    });

    httpResponse.data.on('error', async (err) => {
      logger.warn(`Stream error, falling back: ${err.message}`);
      try {
        const response = await askClaude(telegramId, prompt, dbUser);
        onChunk(response);
        resolve(response);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function askClaudeWithContext(telegramId, fileContext, userInstruction, dbUser) {
  const combined = `${userInstruction}\n\n--- FILE CONTENT ---\n${fileContext}\n--- END ---`;
  return askClaude(telegramId, combined, dbUser);
}

async function askClaudeRaw(prompt) {
  if (ANTHROPIC_API_KEY) {
    try {
      const { data } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: ANTHROPIC_MODEL, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] },
        {
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 60000,
        }
      );
      return data.content?.[0]?.text || '';
    } catch (err) {
      logger.warn(`askClaudeRaw Anthropic failed: ${err.message}`);
    }
  }

  try {
    const params = new URLSearchParams({ prompt });
    const { data } = await axios.get(`${BASE_URL}?${params.toString()}`, { timeout: 60000 });
    if (!data.success) throw new Error('API error');
    return data.response;
  } catch (err) {
    logger.warn(`askClaudeRaw proxy failed: ${err.message}`);
    return await _askFreeApiFallback(prompt);
  }
}

async function resetSession(telegramId) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { sessionId: null } });
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (user) await prisma.message.deleteMany({ where: { userId: user.id } });
}

async function setMode(telegramId, mode) {
  await prisma.user.update({ where: { telegramId: BigInt(telegramId) }, data: { mode } });
}

module.exports = { askClaude, askClaudeStream, askClaudeWithContext, askClaudeRaw, resetSession, setMode, saveMessage };
