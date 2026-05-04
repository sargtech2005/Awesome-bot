// src/services/memoryService.js
// Stores key facts about users and injects them into Claude prompts

const prisma = require('../utils/db');
const logger = require('../utils/logger');

/**
 * Extract memorable facts from a conversation turn using Claude
 * e.g. "I use TypeScript" -> key: "language", value: "TypeScript"
 */
async function extractAndSaveMemory(userId, dbUserId, userText) {
  // Simple rule-based extraction (no extra API call needed)
  const patterns = [
    { regex: /i (?:use|prefer|work with|code in)\s+([A-Za-z0-9+#.\- ]+)/i, key: 'language_or_stack' },
    { regex: /my (?:project|app|system) (?:is|uses?|runs?)\s+([A-Za-z0-9 .]+)/i, key: 'project_type' },
    { regex: /i(?:'m| am) (?:a\s+)?([A-Za-z ]+developer|engineer|designer)/i, key: 'role' },
    { regex: /(?:my name is|call me|i(?:'m| am))\s+([A-Za-z]+)/i, key: 'name' },
    { regex: /i(?:'m| am) (?:from|based in|located in)\s+([A-Za-z ]+)/i, key: 'location' },
    { regex: /(?:using|with)\s+(postgresql|mysql|mongodb|sqlite|redis|supabase)/i, key: 'database' },
    { regex: /(?:hosted on|deployed on|running on)\s+([A-Za-z0-9.\- ]+)/i, key: 'hosting' },
  ];

  for (const { regex, key } of patterns) {
    const match = userText.match(regex);
    if (match) {
      const value = match[1].trim();
      try {
        await prisma.memory.upsert({
          where: { userId_key: { userId: dbUserId, key } },
          update: { value },
          create: { userId: dbUserId, key, value },
        });
        logger.info(`Memory saved for user ${userId}: ${key} = ${value}`);
      } catch (err) {
        logger.error(`Memory save error: ${err.message}`);
      }
    }
  }
}

/**
 * Get all memories for a user as an injected context string
 */
async function getUserMemoryContext(dbUserId) {
  const memories = await prisma.memory.findMany({ where: { userId: dbUserId } });
  if (!memories.length) return '';
  const lines = memories.map((m) => `- ${m.key.replace(/_/g, ' ')}: ${m.value}`).join('\n');
  return `\n[Known facts about this user:\n${lines}]\n`;
}

/**
 * List all memories for display
 */
async function listMemories(dbUserId) {
  return prisma.memory.findMany({ where: { userId: dbUserId }, orderBy: { updatedAt: 'desc' } });
}

/**
 * Delete a specific memory by key
 */
async function deleteMemory(dbUserId, key) {
  return prisma.memory.deleteMany({ where: { userId: dbUserId, key } });
}

/**
 * Clear all memories
 */
async function clearMemories(dbUserId) {
  return prisma.memory.deleteMany({ where: { userId: dbUserId } });
}

module.exports = { extractAndSaveMemory, getUserMemoryContext, listMemories, deleteMemory, clearMemories };
