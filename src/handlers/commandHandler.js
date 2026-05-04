// src/handlers/commandHandler.js — v2

const { getOrCreateUser, getUserHistory, getAllUsers, setUserBanned } = require('../services/userService');
const { resetSession, setMode } = require('../services/claudeService');
const { getUserProjects, formatProjectList } = require('../services/projectService');
const { listMemories, clearMemories } = require('../services/memoryService');
const { getUserStats, getGlobalStats, formatGlobalStats, formatUserStats } = require('../services/statsService');
const { cleanUserTempDir } = require('../utils/helpers');
const { modeKeyboard, projectListKeyboard, adminKeyboard, memoryKeyboard } = require('../utils/keyboards');
const { isGitHubUrl } = require('../services/githubService');
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
      `I'm the *OmegaTech Claude AI Bot* v2 — powered by Claude-pro.\n\n` +
      `*What I can do:*\n` +
      `💬 Chat with Claude (with persistent memory)\n` +
      `🖼️ Analyze images, screenshots & diagrams\n` +
      `📁 Read & analyze any text/code file\n` +
      `📦 Full ZIP IDE — browse, edit, generate files\n` +
      `🐙 Clone any GitHub repo and work on it\n` +
      `💻 Generate code projects → download as ZIP\n` +
      `🧠 Remembers facts about you across sessions\n` +
      `📂 Save & reload named project workspaces\n\n` +
      `*Quick Commands:*\n` +
      `/mode — Switch AI mode (chat/code/debug/explain)\n` +
      `/projects — Your saved projects\n` +
      `/memory — View what I remember about you\n` +
      `/stats — Your usage stats\n` +
      `/help — Full command list\n\n` +
      `Send a message, image, file, ZIP, or GitHub URL to get started! 🚀`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /help ──────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `🤖 *OmegaTech Claude Bot v2 — Help*\n\n` +
      `*🖼️ Images:*\nSend any photo or image file → Claude analyzes it\nAdd a caption for specific instructions:\n` +
      `  • (no caption) = general description\n` +
      `  • \`what does this code do\` = code analysis\n` +
      `  • \`find the bug\` = debug mode\n` +
      `  • \`describe the UI\` = design review\n` +
      `  • \`extract all text\` = OCR\n\n` +
      `*📦 ZIP Workspace:*\nSend a ZIP → inline keyboard appears\n` +
      `Browse files, edit, generate new files, download modified ZIP\n\n` +
      `*🐙 GitHub:*\nPaste any GitHub URL → bot clones it as a workspace\n\n` +
      `*Commands:*\n` +
      `/start — Welcome\n` +
      `/help — This message\n` +
      `/mode — Switch AI mode\n` +
      `/reset — Clear session & history\n` +
      `/history — Last 10 messages\n` +
      `/projects — Saved project workspaces\n` +
      `/memory — View/clear remembered facts\n` +
      `/stats — Your usage statistics\n` +
      `/myid — Your Telegram ID\n` +
      `/clear — Delete temp files\n` +
      `/pack — Download current ZIP\n` +
      `/files — List ZIP workspace files\n\n` +
      `*Admin only:*\n` +
      `/admin — Admin dashboard\n` +
      `/ban <id> — Ban user\n` +
      `/unban <id> — Unban user\n` +
      `/broadcast <msg> — Message all users\n` +
      `/globalstats — Global bot statistics`,
      { parse_mode: 'Markdown' }
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
    await bot.sendMessage(msg.chat.id, '🔄 Session reset! Fresh start — send a message to begin.');
  });

  // ── /history ───────────────────────────────────────────────────
  bot.onText(/\/history/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const history = await prisma.message.findMany({
      where: { userId: dbUser.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    if (!history.length) return bot.sendMessage(msg.chat.id, '📭 No history yet.');
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
      reply_markup: projects.length ? projectListKeyboard(projects) : undefined,
    });
  });

  // ── /memory ────────────────────────────────────────────────────
  bot.onText(/\/memory/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const memories = await listMemories(dbUser.id);
    const text = memories.length
      ? `🧠 *What I remember about you:*\n\n` + memories.map((m) => `• *${m.key.replace(/_/g, ' ')}:* ${m.value}`).join('\n')
      : '🧠 No memories stored yet.\n\nI automatically learn facts from your conversations (your name, stack, project type, etc.)';
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: memoryKeyboard() });
  });

  // ── /stats ─────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    const dbUser = await getOrCreateUser(msg);
    const stats = await getUserStats(dbUser.id);
    await bot.sendMessage(msg.chat.id, formatUserStats(stats, dbUser), { parse_mode: 'Markdown' });
  });

  // ── /myid ──────────────────────────────────────────────────────
  bot.onText(/\/myid/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `🆔 Your Telegram ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
  });

  // ── /clear ─────────────────────────────────────────────────────
  bot.onText(/\/clear/, async (msg) => {
    await cleanUserTempDir(msg.from.id);
    await bot.sendMessage(msg.chat.id, '🗑️ Temp files cleared.');
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
        await new Promise((r) => setTimeout(r, 50)); // throttle
      } catch (_) {}
    }
    await prisma.broadcastLog.create({ data: { message, sentTo: sent, sentBy: BigInt(msg.from.id) } });
    await bot.sendMessage(msg.chat.id, `📢 Broadcast sent to ${sent}/${users.length} users.`);
  });

  logger.info('Commands registered (v2)');
}

module.exports = { registerCommands };
