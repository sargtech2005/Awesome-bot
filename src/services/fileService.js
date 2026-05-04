// src/services/fileService.js
// Downloads files/documents sent to the bot from Telegram servers

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { getUserTempDir, uniqueFilename, isFileSizeOk, detectFileType } = require('../utils/helpers');

const BOT_TOKEN = process.env.BOT_TOKEN;

/**
 * Download a Telegram file to user's temp directory
 * Returns { localPath, fileName, fileType, fileSize }
 */
async function downloadTelegramFile(bot, fileId, userId, originalName = null) {
  const fileInfo = await bot.getFile(fileId);
  const filePath = fileInfo.file_path;
  const fileSize = fileInfo.file_size || 0;

  if (!isFileSizeOk(fileSize)) {
    throw new Error(`File too large (${Math.round(fileSize / 1024 / 1024)}MB). Max is ${process.env.MAX_FILE_SIZE_MB || 50}MB.`);
  }

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const ext = path.extname(originalName || filePath) || '';
  const fileName = originalName || uniqueFilename(ext);
  const userDir = await getUserTempDir(userId);
  const localPath = path.join(userDir, fileName);

  logger.info(`Downloading file: ${fileName} (${fileSize} bytes) for user ${userId}`);

  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  const writer = fs.createWriteStream(localPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return {
    localPath,
    fileName,
    fileType: detectFileType(fileName),
    fileSize,
  };
}

/**
 * Read a plain text/code file and return its content as string
 */
async function readTextFile(localPath) {
  return fs.readFile(localPath, 'utf8');
}

module.exports = { downloadTelegramFile, readTextFile };
