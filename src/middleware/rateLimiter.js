// src/middleware/rateLimiter.js

const logger = require('../utils/logger');

const MAX_PER_MINUTE = parseInt(process.env.MAX_MESSAGES_PER_MINUTE || '20', 10);
const store = new Map(); // telegramId -> { count, resetAt }

function rateLimiter(telegramId) {
  const now = Date.now();
  const entry = store.get(telegramId);

  if (!entry || now > entry.resetAt) {
    store.set(telegramId, { count: 1, resetAt: now + 60_000 });
    return { allowed: true };
  }

  if (entry.count >= MAX_PER_MINUTE) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    logger.warn(`Rate limit hit for user ${telegramId}`);
    return { allowed: false, waitSec };
  }

  entry.count++;
  return { allowed: true };
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.resetAt) store.delete(key);
  }
}, 5 * 60_000);

module.exports = { rateLimiter };
