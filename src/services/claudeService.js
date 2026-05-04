// src/services/claudeService.js — v7 (OmegaTech API fixed + Claude simple endpoint added)

const axios = require('axios');
const logger = require('../utils/logger');
const prisma = require('../utils/db');
const { getUserMemoryContext } = require('./memoryService');

// OmegaTech endpoints — both confirmed WORKING from API docs
const OMEGA_PRO_BASE   = process.env.CLAUDE_API_BASE  || 'https://my-api-rzmb.onrender.com/api/ai/Claude-pro';
const OMEGA_SIMPLE_BASE = 'https://my-api-rzmb.onrender.com/api/ai/Claude';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_HISTORY = 30;

// Model to use on Claude-pro endpoint (deepseek is smart + free)
const OMEGA_MODEL = process.env.OMEGA_MODEL || 'deepseek-v3.2';

const MODE_PREFIXES = {
  chat:    '',
  code:    '[CODE MODE] You are an expert programmer. Write clean, well-commented, production-ready code and always explain it.\n\n',
  debug:   '[DEBUG MODE] You are a debugging expert. Identify bugs, explain root causes, and provide fixed code.\n\n',
  explain: '[EXPLAIN MODE] You are a patient teacher. Explain everything simply with examples. Define all jargon.\n\n',
};

// ─── FREE FALLBACK APIS (no key required unless noted) ──────────────────────
const FREE_APIS = [
  {
    name: 'Pollinations-GET',
    async call(prompt) {
      const encoded = encodeURIComponent(prompt.slice(0, 1000));
      const { data } = await axios.get(
        `https://text.pollinations.ai/${encoded}`,
        { timeout: 30000, responseType: 'text' }
      );
      const text = typeof data === 'string' ? data.trim() : null;
      if (text && text.length > 2) return text;
      throw new Error('Empty response');
    },
  },
  {
    name: 'Pollinations-Mistral',
    async call(prompt) {
      const { data } = await axios.post(
        'https://text.pollinations.ai/',
        { messages: [{ role: 'user', content: prompt }], model: 'mistral', seed: 42 },
        { headers: { 'Content-Type': 'application/json' }, timeout: 35000, responseType: 'text' }
      );
      const text = typeof data === 'string' ? data.trim() : null;
      if (text && text.length > 2) return text;
      throw new Error('Empty response');
    },
  },
  {
    name: 'Pollinations-Llama',
    async call(prompt) {
      const { data } = await axios.post(
        'https://text.pollinations.ai/',
        { messages: [{ role: 'user', content: prompt }], model: 'llama', seed: 42 },
        { headers: { 'Content-Type': 'application/json' }, timeout: 35000, responseType: 'text' }
      );
      const text = typeof data === 'string' ? data.trim() : null;
      if (text && text.length > 2) return text;
      throw new Error('Empty response');
    },
  },
  {
    name: 'HuggingFace-Mistral',
    async call(prompt) {
      const hfKey = process.env.HUGGINGFACE_API_KEY;
      const headers = { 'Content-Type': 'application/json' };
      if (hfKey) headers['Authorization'] = `Bearer ${hfKey}`;
      const { data } = await axios.post(
        'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2',
        { inputs: `<s>[INST] ${prompt} [/INST]`, parameters: { max_new_tokens: 800, return_full_text: false } },
        { headers, timeout: 40000 }
      );
      const text = Array.isArray(data) ? data[0]?.generated_text?.trim() : null;
      if (text && text.length > 2) return text;
      throw new Error('Empty or loading');
    },
  },
  {
    name: 'OpenRouter-Free',
    async call(prompt) {
      const orKey = process.env.OPENROUTER_API_KEY;
      if (!orKey) throw new Error('No OPENROUTER_API_KEY');
      const { data } = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'mistralai/mistral-7b-instruct:free', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 },
        { headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://t.me', 'X-Title': 'DAwesome-Bot' }, timeout: 35000 }
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
      const result = await api.call(prompt);
      logger.info(`Free fallback SUCCESS: ${api.name}`);
      return result;
    } catch (e) {
      logger.warn(`Free fallback ${api.name} failed: ${e.message}`);
    }
  }
  throw new Error('All AI APIs exhausted. Please try again later.');
}

// ─── OMEGA CLAUDE-PRO — FIXED with correct parameters ────────────────────────
// GET /api/ai/Claude-pro?action=chat&prompt=...&model=deepseek-v3.2&chatStyle=chat
//   &tools=none&sessionId=...&clearSession=false
// Response: { statusCode, success, sessionId, model, response, historyCount, ... }
async function _askOmegaPro(prompt, sessionId) {
  const params = new URLSearchParams({
    action: 'chat',
    prompt,
    model: OMEGA_MODEL,
    chatStyle: 'chat',
    tools: 'none',
    clearSession: sessionId ? 'false' : 'true', // keep history when session exists
  });
  if (sessionId) params.append('sessionId', sessionId);

  const url = `${OMEGA_PRO_BASE}?${params.toString()}`;
  logger.info(`OmegaPro GET: ${url.slice(0, 140)}`);

  const { data } = await axios.get(url, { timeout: 60000 });

  if (!data.success) throw new Error(`OmegaPro returned success=false: ${JSON.stringify(data).slice(0, 80)}`);
  const text = data.response;
  if (!text || !text.trim()) throw new Error('OmegaPro returned empty response');

  return {
    text: text.trim(),
    sessionId: data.sessionId || sessionId,
    model: data.model || OMEGA_MODEL,
  };
}

// ─── OMEGA CLAUDE-SIMPLE — /api/ai/Claude?text=... ───────────────────────────
// GET only, one param: text
// Response: { statusCode, success, creator, result, timestamp, attribution }
async function _askOmegaSimple(prompt) {
  const url = `${OMEGA_SIMPLE_BASE}?text=${encodeURIComponent(prompt.slice(0, 800))}`;
  logger.info(`OmegaSimple GET: ${url.slice(0, 140)}`);
  const { data } = await axios.get(url, { timeout: 40000 });
  if (!data.success) throw new Error(`OmegaSimple returned success=false`);
  const text = data.result;
  if (!text || !text.trim()) throw new Error('OmegaSimple returned empty result');
  return { text: text.trim(), sessionId: null };
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
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

// ─── CONVERSATION HISTORY ─────────────────────────────────────────────────────
async function getConversationHistory(dbUserId) {
  const messages = await prisma.message.findMany({
    where: { userId: dbUserId },
    orderBy: { createdAt: 'asc' },
    take: MAX_HISTORY,
  });
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

// ─── PROJECT CONTEXT INJECTION ────────────────────────────────────────────────
// Loads the user's most recent saved project from DB and reads its files from disk
async function getProjectContext(dbUserId) {
  const fs = require('fs-extra');
  const path = require('path');

  // Text-based extensions worth including
  const TEXT_EXTS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.php', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h',
    '.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.html', '.css', '.scss',
    '.sql', '.sh', '.bash', '.prisma', '.graphql', '.env.example',
    '.gitignore', '.eslintrc', '.prettierrc', 'Dockerfile',
  ]);

  try {
    const project = await prisma.project.findFirst({
      where: { userId: dbUserId },
      orderBy: { updatedAt: 'desc' },
    });
    if (!project || !project.extractDir) return '';

    const dirExists = await fs.pathExists(project.extractDir);
    if (!dirExists) return '';

    // Walk the directory and collect text files
    let context = `\n\n[PROJECT: "${project.name}" — ${project.fileCount} files]\n`;
    let totalChars = 0;
    const MAX_CHARS = 40000;

    const walk = async (dir, base) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (totalChars >= MAX_CHARS) break;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(base, entry.name);
        // Skip noise
        if (/node_modules|\.git|dist|build/.test(relPath)) continue;
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const base2 = path.basename(entry.name);
          if (!TEXT_EXTS.has(ext) && !TEXT_EXTS.has(base2)) continue;
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            if (content.length > 15000) continue; // skip huge single files
            const block = `\n### FILE: ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`;
            context += block;
            totalChars += block.length;
          } catch (_) {}
        }
      }
    };

    await walk(project.extractDir, '');
    return context;
  } catch (err) {
    logger.warn(`getProjectContext error: ${err.message}`);
    return '';
  }
}

// ─── PUBLIC: askClaude ────────────────────────────────────────────────────────
// Priority: 1) Anthropic direct  2) OmegaTech Claude-Pro  3) OmegaTech Claude  4) Free APIs
async function askClaude(telegramId, prompt, dbUser) {
  const mode       = dbUser.mode || 'chat';
  const modePrefix = MODE_PREFIXES[mode] || '';
  const memCtx     = await getUserMemoryContext(dbUser.id);

  // ── Inject conversation history + project context ──────────────
  const history      = await getConversationHistory(dbUser.id);
  const projectCtx   = await getProjectContext(dbUser.id);

  // Build a system-style preamble so Claude knows about the project
  const systemPreamble = projectCtx
    ? `You are D'Awesome Bot, a helpful AI assistant on Telegram powered by Claude.\nYou have direct access to the user's uploaded project files shown below. NEVER say you cannot see the code — you already have it.\nAlways read the project files before answering questions about the project.\n${projectCtx}\n[END OF PROJECT FILES]\n`
    : `You are D'Awesome Bot, a helpful AI assistant on Telegram powered by Claude. Answer clearly and accurately.\n`;

  const fullPrompt = `${modePrefix}${memCtx}${prompt}`;

  let responseText = null;

  // ── 1. Anthropic direct ───────────────────────────────────────
  if (ANTHROPIC_API_KEY) {
    try {
      logger.info(`Anthropic direct | user=${telegramId} mode=${mode}`);

      // Build messages array: prior history + current user message
      const messages = [
        ...history,
        { role: 'user', content: fullPrompt },
      ];

      const { data } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          system: systemPreamble,
          messages,
        },
        {
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 120000,
        }
      );
      responseText = data.content?.[0]?.text || null;
      if (responseText) logger.info(`Anthropic OK for ${telegramId}`);
    } catch (e) {
      logger.warn(`Anthropic failed: ${e.message}`);
    }
  }

  // ── 2. OmegaTech Claude-Pro (deepseek-v3.2, session memory) ──
  if (!responseText) {
    try {
      logger.info(`OmegaPro | user=${telegramId} session=${dbUser.sessionId || 'new'}`);
      // Omega has no separate system param — prepend preamble + history into prompt
      const historyText = history.length
        ? '\n[Previous conversation:\n' + history.map(m => `${m.role}: ${m.content}`).join('\n') + ']\n'
        : '';
      const omegaPrompt = systemPreamble + historyText + fullPrompt;
      const result = await _askOmegaPro(omegaPrompt, dbUser.sessionId);
      responseText = result.text;
      if (result.sessionId && result.sessionId !== dbUser.sessionId) {
        await saveSessionId(telegramId, result.sessionId);
        dbUser.sessionId = result.sessionId;
        logger.info(`Saved OmegaPro sessionId ${result.sessionId} for ${telegramId}`);
      }
    } catch (e) {
      logger.warn(`OmegaPro failed: ${e.message}`);
    }
  }

  // ── 3. OmegaTech Claude-Simple (no session, faster) ──────────
  if (!responseText) {
    try {
      logger.info(`OmegaSimple | user=${telegramId}`);
      const result = await _askOmegaSimple(systemPreamble + fullPrompt);
      responseText = result.text;
    } catch (e) {
      logger.warn(`OmegaSimple failed: ${e.message}`);
    }
  }

  // ── 4. Free fallback APIs ─────────────────────────────────────
  if (!responseText) {
    logger.warn(`All Omega APIs failed for ${telegramId} — trying free fallbacks`);
    responseText = await _askFreeApis(systemPreamble + fullPrompt);
  }

  await saveMessage(dbUser.id, 'user', prompt, mode);
  await saveMessage(dbUser.id, 'assistant', responseText, mode);
  await incrementMessages(dbUser.id);

  return responseText;
}

// ─── PUBLIC: askClaudeStream ──────────────────────────────────────────────────
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

  // Inject history and project context — same as askClaude
  const history    = await getConversationHistory(dbUser.id);
  const projectCtx = await getProjectContext(dbUser.id);
  const systemPreamble = projectCtx
    ? `You are D'Awesome Bot, a helpful AI assistant on Telegram powered by Claude.\nYou have direct access to the user's uploaded project files shown below. NEVER say you cannot see the code — you already have it.\nAlways read the project files before answering questions about the project.\n${projectCtx}\n[END OF PROJECT FILES]\n`
    : `You are D'Awesome Bot, a helpful AI assistant on Telegram powered by Claude. Answer clearly and accurately.\n`;

  const messages = [
    ...history,
    { role: 'user', content: fullPrompt },
  ];

  let httpRes;
  try {
    httpRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        stream: true,
        system: systemPreamble,
        messages,
      },
      {
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        responseType: 'stream', timeout: 120000,
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
  // Try OmegaPro
  try { return (await _askOmegaPro(prompt, null)).text; } catch (_) {}
  // Try OmegaSimple
  try { return (await _askOmegaSimple(prompt)).text; } catch (_) {}
  return await _askFreeApis(prompt);
}

// ─── PUBLIC: resetSession ────────────────────────────────────────────────────
async function resetSession(telegramId) {
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
