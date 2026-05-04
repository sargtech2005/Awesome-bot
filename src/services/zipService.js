// src/services/zipService.js
// Handles zip upload, extraction, file listing, editing, and repacking

const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { detectFileType, formatBytes } = require('../utils/helpers');

const MAX_READABLE_SIZE = 200 * 1024; // 200KB per file for reading into context

/**
 * Extract a zip file to a destination directory
 * Returns a manifest of extracted files
 */
async function extractZip(zipPath, destDir) {
  await fs.ensureDir(destDir);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);

  const manifest = buildManifest(destDir);
  logger.info(`Extracted ${manifest.length} files from zip to ${destDir}`);
  return manifest;
}

/**
 * Recursively build a file manifest from a directory
 */
function buildManifest(dir, base = dir) {
  const items = fs.readdirSync(dir);
  let files = [];
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    const relPath = path.relative(base, fullPath);
    if (stat.isDirectory()) {
      files = files.concat(buildManifest(fullPath, base));
    } else {
      files.push({
        name: item,
        relPath,
        fullPath,
        size: stat.size,
        sizeHuman: formatBytes(stat.size),
        type: detectFileType(item),
      });
    }
  }
  return files;
}

/**
 * Format manifest as a readable Telegram message
 */
function formatManifest(manifest) {
  if (manifest.length === 0) return '📦 ZIP is empty.';
  const lines = manifest.map((f) => {
    const icon = iconFor(f.type);
    return `${icon} \`${f.relPath}\` (${f.sizeHuman})`;
  });
  return `📦 *ZIP Contents (${manifest.length} files):*\n\n${lines.join('\n')}`;
}

function iconFor(type) {
  if (type === 'code') return '💻';
  if (type === 'text') return '📄';
  if (type === 'zip') return '📦';
  return '📎';
}

/**
 * Read a specific file from extracted dir (by relative path)
 * Returns text content (truncated if large)
 */
async function readFile(extractDir, relPath) {
  const fullPath = path.join(extractDir, relPath);
  if (!await fs.pathExists(fullPath)) throw new Error(`File not found: ${relPath}`);
  const stat = await fs.stat(fullPath);
  if (stat.size > MAX_READABLE_SIZE) {
    const content = await fs.readFile(fullPath, 'utf8');
    return { content: content.slice(0, MAX_READABLE_SIZE), truncated: true, size: stat.size };
  }
  const content = await fs.readFile(fullPath, 'utf8');
  return { content, truncated: false, size: stat.size };
}

/**
 * Move / rename a file inside extracted dir
 */
async function moveFile(extractDir, oldRelPath, newRelPath) {
  const oldFull = path.join(extractDir, oldRelPath);
  const newFull = path.join(extractDir, newRelPath);
  if (!await fs.pathExists(oldFull)) throw new Error(`File not found: ${oldRelPath}`);
  await fs.ensureDir(path.dirname(newFull));
  await fs.move(oldFull, newFull, { overwrite: false });
  logger.info(`Moved: ${oldRelPath} → ${newRelPath}`);
}

/**
 * Delete a file inside extracted dir
 */
async function deleteFile(extractDir, relPath) {
  const fullPath = path.join(extractDir, relPath);
  if (!await fs.pathExists(fullPath)) throw new Error(`File not found: ${relPath}`);
  await fs.remove(fullPath);
  logger.info(`Deleted: ${relPath}`);
}

/**
 * Write content to a file inside extracted dir
 */
async function writeFile(extractDir, relPath, content) {
  const fullPath = path.join(extractDir, relPath);
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, content, 'utf8');
  logger.info(`Wrote file: ${relPath}`);
}

/**
 * Create a new zip from a directory
 */
async function packZip(sourceDir, outputZipPath) {
  const zip = new AdmZip();
  await addDirToZip(zip, sourceDir, sourceDir);
  zip.writeZip(outputZipPath);
  const stat = await fs.stat(outputZipPath);
  logger.info(`Packed zip: ${outputZipPath} (${formatBytes(stat.size)})`);
  return { path: outputZipPath, size: stat.size, sizeHuman: formatBytes(stat.size) };
}

async function addDirToZip(zip, dir, base) {
  const items = await fs.readdir(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = await fs.stat(fullPath);
    const zipPath = path.relative(base, dir);
    if (stat.isDirectory()) {
      await addDirToZip(zip, fullPath, base);
    } else {
      zip.addLocalFile(fullPath, zipPath || undefined);
    }
  }
}

/**
 * Get all readable text files from extracted zip as a combined context string
 * (used when sending full project to Claude)
 */
async function buildProjectContext(manifest, extractDir, maxTotalChars = 40000) {
  let context = '';
  for (const file of manifest) {
    if (!['code', 'text'].includes(file.type)) continue;
    if (file.size > MAX_READABLE_SIZE) continue;
    try {
      const content = await fs.readFile(file.fullPath, 'utf8');
      const block = `\n\n### FILE: ${file.relPath}\n\`\`\`\n${content}\n\`\`\``;
      if (context.length + block.length > maxTotalChars) break;
      context += block;
    } catch (_) {
      // skip unreadable files
    }
  }
  return context;
}

module.exports = {
  extractZip,
  buildManifest,
  formatManifest,
  readFile,
  writeFile,
  moveFile,
  deleteFile,
  packZip,
  buildProjectContext,
};
