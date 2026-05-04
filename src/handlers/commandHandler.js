// src/handlers/commandHandler.js — v3 (inline buttons, no /cmd spam)

const { getOrCreateUser, getUserHistory, getAllUsers, setUserBanned } = require('../services/userService');
const { resetSession, setMode } = require('../services/claudeService');
const { getUserProjects, formatProjectList } = require('../services/projectService');
const { listMemories, clearMemories } = require('../services/memoryService');
const { getUserStats, getGlobalStats, formatGlobalStats, formatUserStats } = require('../services/statsService');
const { cleanUserTempDir } = require('../utils/helpers');
const { modeKeyboard, projectListKeyboard, adminKeyboard, memoryKeyboard, mainMenuKeyboard } = require('../utils/keyboards');
const logger = require('../utils/logger');
const prisma = require('../utils/db');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

function registerCommands(bot) {

  // ── /start ─────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    await getOrCreateUser(msg);
    const name = msg.from.first_name || 'there';
    await bot.sendMessage(msg.chat.id,
      `👋 *Welcome, ${name}!*\n\n` +
      `I'm *D'Awesome Bot* — your Claude AI assistant.\n\n` +
      `*What I can do:*\n` +
      `💬 Chat with Claude (with persistent memory)\n` +
      `🖼️ Analyze images, screenshots & diagrams\n` +
      `📁 Read & analyze any text/code file\n` +
      `📦 Full ZIP IDE — browse, edit, generate files\n` +
      `🐙 Clone any GitHub repo and work on it\n` +
      `💻 Generate code projects → download as ZIP\n` +
      `🧠 Remembers facts about you across sessions\n` +
      `📂 Save & reload named project workspaces\n\n` +
      `Send a message, image, file, ZIP, or GitHub URL to get started! 🚀\n\n` +
      `Use the buttons below to access all features:`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
  });

  // ── /help ──────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `🤖 *D'Awesome Bot — Help*\n\n` +
      `*🖼️ Images:* Send any photo → Claude analyzes it\n` +
      `*📦 ZIP:* Send a ZIP → inline browser appears\n` +
      `*🐙 GitHub:* Paste a GitHub URL → bot clones it\n` +
      `*💬 Chat:* Just type anything to talk to Claude\n\n` +
      `Use the buttons below to switch modes, view projects, stats and more:`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
  });

  // ── /mode ──────────────────────────────────────────────────────
  bot.onText(/\/mode/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    await bot.sendMessage(msg.chat.id,
      `🎛️ *Select AI Mode*\n\n` +
      `💬 *Chat* — General conversation\n` +
      `💻 *Code* — Expert programmer, production-ready code\n` +
      `🐛 *Debug* — Find & fix bugs, explain root causes\n` +
      `📖 *Explain* — Patient teacher, simple explanations\n\n` +
      `Current mode: *${dbUser.mode || 'chat'}*`,
      { parse_mode: 'Markdown', reply_markup: modeKeyboard(dbUser.mode || 'chat') }
    );
  });

  // ── /reset ─────────────────────────────────────────────────────
  bot.onText(/\/reset/, async (msg) => {
    await getOrCreateUser(msg);
    await resetSession(msg.from.id);
    await cleanUserTempDir(msg.from.id);
    await bot.sendMessage(msg.chat.id, '🔄 Session reset! Fresh start — send a message to begin.', { reply_markup: mainMenuKeyboard() });
  });

  // ── /history ───────────────────────────────────────────────────
  bot.onText(/\/history/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const history = await prisma.message.findMany({
      where: { userId: dbUser.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    if (!history.length) return bot.sendMessage(msg.chat.id, '📭 No history yet.', { reply_markup: mainMenuKeyboard() });
    const lines = history.reverse().map((m) =>
      `*${m.role === 'user' ? '👤 You' : '🤖 Claude'}:*\n${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`
    ).join('\n\n---\n\n');
    await bot.sendMessage(msg.chat.id, `📜 *Last ${history.length} messages:*\n\n${lines}`, { parse_mode: 'Markdown' });
  });

  // ── /projects ──────────────────────────────────────────────────
  bot.onText(/\/projects/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const projects = await getUserProjects(dbUser.id);
    await bot.sendMessage(msg.chat.id, formatProjectList(projects), {
      parse_mode: 'Markdown',
      reply_markup: projectListKeyboard(projects),
    });
  });

  // ── /memory ────────────────────────────────────────────────────
  bot.onText(/\/memory/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const memories = await listMemories(dbUser.id);
    const text = memories.length
      ? `🧠 *What I remember about you:*\n\n` + memories.map((m) => `• *${m.key.replace(/_/g, ' ')}:* ${m.value}`).join('\n')
      : '🧠 No memories stored yet.\n\nI automatically learn facts from your conversations.';
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: memoryKeyboard() });
  });

  // ── /stats ─────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const stats = await getUserStats(dbUser.id);
    await bot.sendMessage(msg.chat.id, formatUserStats(stats, dbUser), { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
  });

  // ── /myid ──────────────────────────────────────────────────────
  bot.onText(/\/myid/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `🆔 Your Telegram ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
  });

  // ── /clear ─────────────────────────────────────────────────────
  bot.onText(/\/clear/, async (msg) => {
    await cleanUserTempDir(msg.from.id);
    await bot.sendMessage(msg.chat.id, '🗑️ Temp files cleared.', { reply_markup: mainMenuKeyboard() });
  });

  // ── /admin ─────────────────────────────────────────────────────
  bot.onText(/\/admin/, async (msg) => {
    if (String(msg.from.id) !== String(ADMIN_CHAT_ID)) return bot.sendMessage(msg.chat.id, '🚫 Admin only.');
    await bot.sendMessage(msg.chat.id, '👮 *Admin Dashboard*', { parse_mode: 'Markdown', reply_markup: adminKeyboard() });
  });

  // ── /globalstats ───────────────────────────────────────────────
  bot.onText(/\/globalstats/, async (msg) => {
    if (String(msg.from.id) !== String(ADMIN_CHAT_ID)) return bot.sendMessage(msg.chat.id, '🚫 Admin only.');
    const stats = await getGlobalStats();
    await bot.sendMessage(msg.chat.id, formatGlobalStats(stats), { parse_mode: 'Markdown' });
  });

  // ── /ban <id> ──────────────────────────────────────────────────
  bot.onText(/\/ban (\d+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(ADMIN_CHAT_ID)) return;
    await setUserBanned(BigInt(match[1]), true);
    await bot.sendMessage(msg.chat.id, `🚫 User ${match[1]} banned.`);
  });

  // ── /unban <id> ────────────────────────────────────────────────
  bot.onText(/\/unban (\d+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(ADMIN_CHAT_ID)) return;
    await setUserBanned(BigInt(match[1]), false);
    await bot.sendMessage(msg.chat.id, `✅ User ${match[1]} unbanned.`);
  });

  // ── /broadcast <message> ───────────────────────────────────────
  bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(ADMIN_CHAT_ID)) return;
    const message = match[1];
    const users = await getAllUsers();
    let sent = 0;
    for (const user of users) {
      try {
        await bot.sendMessage(String(user.telegramId), `📢 *Announcement:*\n\n${message}`, { parse_mode: 'Markdown' });
        sent++;
        await new Promise((r) => setTimeout(r, 50));
      } catch (_) {}
    }
    await prisma.broadcastLog.create({ data: { message, sentTo: sent, sentBy: BigInt(msg.from.id) } });
    await bot.sendMessage(msg.chat.id, `📢 Broadcast sent to ${sent}/${users.length} users.`);
  });

  // ── /apitest (admin) — test which AI API responds ─────────────
  bot.onText(/\/apitest/, async (msg) => {
    if (String(msg.from.id) !== String(ADMIN_CHAT_ID)) return bot.sendMessage(msg.chat.id, '🚫 Admin only.');
    const axios = require('axios');
    const results = [];
    const OMEGA = process.env.CLAUDE_API_BASE || 'https://my-api-rzmb.onrender.com/api/ai/Claude-pro';
    const testPrompt = 'Reply with exactly: OK';

    // Test Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const t = Date.now();
        const { data } = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: 'claude-haiku-4-5-20251001', max_tokens: 50, messages: [{ role: 'user', content: testPrompt }] },
          { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 }
        );
        results.push(`✅ Anthropic (${Date.now()-t}ms): ${data.content?.[0]?.text?.slice(0,30)}`);
      } catch (e) { results.push(`❌ Anthropic: ${e.message.slice(0,60)}`); }
    } else results.push('⏭️ Anthropic: No key set');

    // Test OmegaTech Claude-Pro (correct params: action, model, chatStyle, tools)
    try {
      const t = Date.now();
      const params = new URLSearchParams({
        action: 'chat', prompt: testPrompt,
        model: 'deepseek-v3.2', chatStyle: 'chat', tools: 'none', clearSession: 'true',
      });
      const { data } = await axios.get(`${OMEGA}?${params}`, { timeout: 25000 });
      if (data?.success && data?.response) {
        results.push(`✅ OmegaPro (${Date.now()-t}ms): "${data.response.slice(0,35)}" [${data.model}]`);
      } else {
        results.push(`⚠️ OmegaPro unexpected format: ${JSON.stringify(data).slice(0,60)}`);
      }
    } catch (e) { results.push(`❌ OmegaPro: ${e.message.slice(0,80)}`); }

    // Test OmegaTech Claude-Simple (/api/ai/Claude?text=...)
    try {
      const t = Date.now();
      const simpleBase = 'https://my-api-rzmb.onrender.com/api/ai/Claude';
      const { data } = await axios.get(`${simpleBase}?text=${encodeURIComponent(testPrompt)}`, { timeout: 20000 });
      if (data?.success && data?.result) {
        results.push(`✅ OmegaSimple (${Date.now()-t}ms): "${data.result.slice(0,35)}"`);
      } else {
        results.push(`⚠️ OmegaSimple unexpected format: ${JSON.stringify(data).slice(0,60)}`);
      }
    } catch (e) { results.push(`❌ OmegaSimple: ${e.message.slice(0,80)}`); }


    // Test Pollinations GET (keyless)
    try {
      const t = Date.now();
      const { data } = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(testPrompt)}`, { timeout: 15000, responseType: 'text' });
      const text = typeof data === 'string' ? data.slice(0, 40) : '(non-string)';
      results.push(`✅ Pollinations-GET (${Date.now()-t}ms): ${text}`);
    } catch (e) { results.push(`❌ Pollinations-GET: ${e.message.slice(0,60)}`); }

    // Test Pollinations POST (keyless)
    try {
      const t = Date.now();
      const { data } = await axios.post('https://text.pollinations.ai/', { messages:[{role:'user',content:testPrompt}], model:'mistral', seed:42 }, { headers:{'Content-Type':'application/json'}, timeout: 15000, responseType: 'text' });
      const text = typeof data === 'string' ? data.slice(0, 40) : JSON.stringify(data).slice(0,40);
      results.push(`✅ Pollinations-POST (${Date.now()-t}ms): ${text}`);
    } catch (e) { results.push(`❌ Pollinations-POST: ${e.message.slice(0,60)}`); }

    // Test HuggingFace (keyless)
    try {
      const t = Date.now();
      const hfHeaders = { 'Content-Type': 'application/json' };
      if (process.env.HUGGINGFACE_API_KEY) hfHeaders['Authorization'] = `Bearer ${process.env.HUGGINGFACE_API_KEY}`;
      const { data } = await axios.post(
        'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2',
        { inputs: `<s>[INST] ${testPrompt} [/INST]`, parameters: { max_new_tokens: 20, return_full_text: false } },
        { headers: hfHeaders, timeout: 20000 }
      );
      const text = Array.isArray(data) ? data[0]?.generated_text?.slice(0,40) : JSON.stringify(data).slice(0,40);
      results.push(`✅ HuggingFace (${Date.now()-t}ms): ${text}`);
    } catch (e) { results.push(`❌ HuggingFace: ${e.message.slice(0,60)}`); }

    // Test Groq (needs key)
    if (process.env.GROQ_API_KEY) {
      try {
        const t = Date.now();
        const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions',
          { model: 'llama3-8b-8192', messages: [{role:'user',content:testPrompt}], max_tokens: 20 },
          { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        results.push(`✅ Groq (${Date.now()-t}ms): ${data?.choices?.[0]?.message?.content?.slice(0,30)}`);
      } catch (e) { results.push(`❌ Groq: ${e.message.slice(0,60)}`); }
    } else results.push('⏭️ Groq: No GROQ_API_KEY set');

    await bot.sendMessage(msg.chat.id, `🔬 *API Test Results:*\n\n${results.join('\n')}`, { parse_mode: 'Markdown' });
  });

  logger.info('Commands registered (v3)');
}

module.exports = { registerCommands };
