// src/services/githubService.js
// Clones a GitHub repo into a user's workspace as a ZIP session

const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
const { getUserTempDir, formatBytes } = require('../utils/helpers');
const { buildManifest } = require('./zipService');
const { packZip } = require('./zipService');
const logger = require('../utils/logger');

/**
 * Clone a GitHub repo for a user
 * Returns { extractDir, manifest, repoName, size }
 */
async function cloneRepo(telegramId, repoUrl) {
  const userDir = await getUserTempDir(telegramId);
  const repoName = extractRepoName(repoUrl);
  const cloneDir = path.join(userDir, `github_${repoName}_${Date.now()}`);

  await fs.ensureDir(cloneDir);

  logger.info(`Cloning ${repoUrl} for user ${telegramId}`);

  const git = simpleGit({ timeout: { block: 60000 } });
  await git.clone(repoUrl, cloneDir, ['--depth', '1', '--single-branch']);

  // Remove .git directory to save space
  await fs.remove(path.join(cloneDir, '.git'));

  const manifest = buildManifest(cloneDir);
  const totalSize = manifest.reduce((acc, f) => acc + f.size, 0);

  logger.info(`Cloned ${manifest.length} files (${formatBytes(totalSize)}) for user ${telegramId}`);

  return {
    extractDir: cloneDir,
    manifest,
    repoName,
    fileCount: manifest.length,
    totalSize,
    totalSizeHuman: formatBytes(totalSize),
  };
}

/**
 * Extract repo name from URL
 */
function extractRepoName(url) {
  const match = url.match(/github\.com[/:][^/]+\/([^/.]+)/);
  return match ? match[1] : 'repo';
}

/**
 * Validate it's a GitHub URL
 */
function isGitHubUrl(text) {
  return /https?:\/\/github\.com\/[\w.\-]+\/[\w.\-]+/.test(text);
}

module.exports = { cloneRepo, isGitHubUrl, extractRepoName };
