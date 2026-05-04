// src/services/statsService.js

const prisma = require('../utils/db');

async function incrementStat(dbUserId, field) {
  await prisma.userStats.upsert({
    where: { userId: dbUserId },
    update: {
      [field]: { increment: 1 },
      lastActiveAt: new Date(),
    },
    create: {
      userId: dbUserId,
      [field]: 1,
      lastActiveAt: new Date(),
    },
  });
}

async function getUserStats(dbUserId) {
  return prisma.userStats.findUnique({ where: { userId: dbUserId } });
}

async function getGlobalStats() {
  const [users, messages, stats] = await Promise.all([
    prisma.user.count(),
    prisma.message.count(),
    prisma.userStats.aggregate({
      _sum: {
        totalMessages: true,
        totalFiles: true,
        totalZips: true,
        totalEdits: true,
        totalCodeGens: true,
      },
    }),
  ]);

  const activeToday = await prisma.userStats.count({
    where: { lastActiveAt: { gte: new Date(Date.now() - 86400000) } },
  });

  return { users, messages, activeToday, sums: stats._sum };
}

function formatGlobalStats(stats) {
  const s = stats.sums;
  return (
    `📊 *Bot Statistics*\n\n` +
    `👥 Total users: *${stats.users}*\n` +
    `🟢 Active today: *${stats.activeToday}*\n` +
    `💬 Total messages: *${stats.messages}*\n` +
    `📁 Files processed: *${s.totalFiles || 0}*\n` +
    `📦 ZIPs processed: *${s.totalZips || 0}*\n` +
    `✏️ File edits: *${s.totalEdits || 0}*\n` +
    `💻 Code generations: *${s.totalCodeGens || 0}*`
  );
}

function formatUserStats(stats, user) {
  if (!stats) return '📊 No activity yet.';
  const name = user.firstName || user.username || 'You';
  return (
    `📊 *${name}'s Stats*\n\n` +
    `💬 Messages: *${stats.totalMessages}*\n` +
    `📁 Files uploaded: *${stats.totalFiles}*\n` +
    `📦 ZIPs processed: *${stats.totalZips}*\n` +
    `✏️ File edits: *${stats.totalEdits}*\n` +
    `💻 Code generations: *${stats.totalCodeGens}*\n` +
    `🕐 Last active: *${stats.lastActiveAt.toLocaleDateString()}*`
  );
}

module.exports = { incrementStat, getUserStats, getGlobalStats, formatGlobalStats, formatUserStats };
