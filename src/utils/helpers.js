// src/utils/helpers.js

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const TEMP_DIR = path.join(process.cwd(), process.env.TEMP_DIR || 'temp');

/**
 * Ensure temp directory exists and return a unique session folder for a user
 */
async function getUserTempDir(userId) {
  const dir = path.join(TEMP_DIR, String(userId));
  await fs.ensureDir(dir);
  return dir;
}

/**
 * Clean up a user's temp folder
 */
async function cleanUserTempDir(userId) {
  const dir = path.join(TEMP_DIR, String(userId));
  await fs.remove(dir);
}

/**
 * Generate a unique filename
 */
function uniqueFilename(ext = '') {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

/**
 * Get human-readable file size
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Truncate text for Telegram's 4096 char limit
 */
function truncate(text, limit = 4000) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n... [truncated]';
}

/**
 * Detect file type from extension
 */
function detectFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const codeExts = ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rs',
    '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.html', '.css',
    '.json', '.yaml', '.yml', '.toml', '.xml', '.sql'];
  const textExts = ['.txt', '.md', '.csv', '.log', '.env', '.conf', '.ini'];

  if (ext === '.zip') return 'zip';
  if (codeExts.includes(ext)) return 'code';
  if (textExts.includes(ext)) return 'text';
  return 'other';
}

/**
 * Check if file size is within limit
 */
function isFileSizeOk(bytes) {
  const limitMB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
  return bytes <= limitMB * 1024 * 1024;
}

/**
 * Escape Markdown V2 special chars for Telegram
 */
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Split long text into chunks safe for Telegram
 */
function splitIntoChunks(text, chunkSize = 4000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

module.exports = {
  getUserTempDir,
  cleanUserTempDir,
  uniqueFilename,
  formatBytes,
  truncate,
  detectFileType,
  isFileSizeOk,
  escapeMarkdown,
  splitIntoChunks,
  TEMP_DIR,
};
