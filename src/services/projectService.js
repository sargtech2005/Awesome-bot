// src/services/projectService.js
// Named ZIP workspace sessions stored in PostgreSQL

const prisma = require('../utils/db');
const fs = require('fs-extra');
const path = require('path');
const { getUserTempDir } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Save a ZIP workspace as a named project
 */
async function saveProject(dbUserId, telegramId, name, extractDir, { originalZip, source, sourceUrl, fileCount } = {}) {
  return prisma.project.create({
    data: {
      userId: dbUserId,
      name,
      extractDir,
      originalZip: originalZip || null,
      source: source || 'upload',
      sourceUrl: sourceUrl || null,
      fileCount: fileCount || 0,
    },
  });
}

/**
 * Update an existing project
 */
async function updateProject(id, data) {
  return prisma.project.update({ where: { id }, data });
}

/**
 * Get all projects for a user
 */
async function getUserProjects(dbUserId) {
  return prisma.project.findMany({
    where: { userId: dbUserId },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * Get a project by ID (with ownership check)
 */
async function getProject(id, dbUserId) {
  return prisma.project.findFirst({ where: { id, userId: dbUserId } });
}

/**
 * Delete a project and its files
 */
async function deleteProject(id, dbUserId) {
  const project = await getProject(id, dbUserId);
  if (!project) throw new Error('Project not found');
  await fs.remove(project.extractDir).catch(() => {});
  if (project.originalZip) await fs.remove(project.originalZip).catch(() => {});
  return prisma.project.delete({ where: { id } });
}

/**
 * Format project list for Telegram
 */
function formatProjectList(projects) {
  if (!projects.length) return '📂 No saved projects yet.';
  return (
    `📂 *Your Projects (${projects.length}):*\n\n` +
    projects
      .map((p, i) => `${i + 1}. *${p.name}* — ${p.fileCount} files | ${p.source}${p.sourceUrl ? ` (${p.sourceUrl})` : ''}\n   ID: \`${p.id}\``)
      .join('\n\n')
  );
}

module.exports = { saveProject, updateProject, getUserProjects, getProject, deleteProject, formatProjectList };
