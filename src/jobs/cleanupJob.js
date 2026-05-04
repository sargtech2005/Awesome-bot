// src/jobs/cleanupJob.js
// Runs every hour — deletes temp files older than 24h

const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { TEMP_DIR } = require('../utils/helpers');

function startCleanupJob(bot, adminChatId) {
  // Every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const dirs = await fs.readdir(TEMP_DIR).catch(() => []);
      let cleaned = 0;
      let freedBytes = 0;

      for (const dir of dirs) {
        const fullPath = path.join(TEMP_DIR, dir);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) continue;

        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          // Get size before deleting
          const size = await getDirSize(fullPath);
          await fs.remove(fullPath);
          cleaned++;
          freedBytes += size;
        }
      }

      if (cleaned > 0) {
        const mb = (freedBytes / 1024 / 1024).toFixed(1);
        logger.info(`Cleanup: removed ${cleaned} temp dirs, freed ${mb}MB`);

        // Notify admin silently
        if (adminChatId) {
          await bot.sendMessage(adminChatId, `🗑️ Auto-cleanup: removed ${cleaned} temp session(s), freed ${mb}MB`).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(`Cleanup job error: ${err.message}`);
    }
  });

  logger.info('Cleanup job scheduled (every hour)');
}

async function getDirSize(dir) {
  let total = 0;
  try {
    const items = await fs.readdir(dir);
    for (const item of items) {
      const p = path.join(dir, item);
      const stat = await fs.stat(p).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) total += await getDirSize(p);
      else total += stat.size;
    }
  } catch (_) {}
  return total;
}

module.exports = { startCleanupJob };
