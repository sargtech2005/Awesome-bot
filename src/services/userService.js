// src/services/userService.js

const prisma = require('../utils/db');
const logger = require('../utils/logger');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

/**
 * Get or create a user from a Telegram message
 */
async function getOrCreateUser(msg) {
  const { id: telegramId, username, first_name, last_name } = msg.from;

  try {
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(telegramId) },
      update: { username: username || null, firstName: first_name || null, lastName: last_name || null },
      create: {
        telegramId: BigInt(telegramId),
        username: username || null,
        firstName: first_name || null,
        lastName: last_name || null,
        isAdmin: String(telegramId) === String(ADMIN_CHAT_ID),
      },
    });
    return user;
  } catch (err) {
    logger.error(`getOrCreateUser error: ${err.message}`);
    throw err;
  }
}

/**
 * Check if user is banned
 */
async function isUserBanned(telegramId) {
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  return user?.isBanned || false;
}

/**
 * Get all users (admin only)
 */
async function getAllUsers() {
  return prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
}

/**
 * Ban/unban a user
 */
async function setUserBanned(telegramId, banned) {
  return prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: { isBanned: banned },
  });
}

/**
 * Get message history for a user
 */
async function getUserHistory(userId, limit = 10) {
  return prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

module.exports = { getOrCreateUser, isUserBanned, getAllUsers, setUserBanned, getUserHistory };
