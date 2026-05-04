// src/utils/keyboards.js
// All inline keyboard layouts for the bot

/**
 * Main menu keyboard shown in /start and /help
 */
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🎛️ Switch Mode', callback_data: 'menu:mode' },
        { text: '📂 My Projects', callback_data: 'menu:projects' },
      ],
      [
        { text: '🧠 Memory', callback_data: 'menu:memory' },
        { text: '📊 My Stats', callback_data: 'menu:stats' },
      ],
      [
        { text: '🔄 Reset Session', callback_data: 'menu:reset' },
        { text: '🆔 My ID', callback_data: 'menu:myid' },
      ],
      [
        { text: '🗑️ Clear Temp Files', callback_data: 'menu:clear' },
      ],
    ],
  };
}

/**
 * Keyboard shown after a ZIP is loaded
 */
function zipMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📄 Browse Files', callback_data: 'zip:browse:0' },
        { text: '🔍 Analyze Project', callback_data: 'zip:analyze' },
      ],
      [
        { text: '💻 Generate File', callback_data: 'zip:gen_prompt' },
        { text: '📦 Download ZIP', callback_data: 'zip:pack' },
      ],
      [
        { text: '💾 Save Project', callback_data: 'zip:save_prompt' },
        { text: '🗑️ Clear Session', callback_data: 'zip:clear' },
      ],
    ],
  };
}

/**
 * File browser keyboard — paginated list of files
 */
function fileBrowserKeyboard(manifest, page = 0, pageSize = 8) {
  const start = page * pageSize;
  const slice = manifest.slice(start, start + pageSize);
  const totalPages = Math.ceil(manifest.length / pageSize);

  const fileRows = slice.map((f) => [
    {
      text: `${iconFor(f.type)} ${f.relPath.length > 35 ? '…' + f.relPath.slice(-33) : f.relPath}`,
      callback_data: `file:read:${encodeFilePath(f.relPath)}`,
    },
  ]);

  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `zip:browse:${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `zip:browse:${page + 1}` });

  const rows = [...fileRows];
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔙 Back to Menu', callback_data: 'zip:menu' }]);

  return { inline_keyboard: rows };
}

/**
 * File action keyboard (after selecting a file)
 */
function fileActionKeyboard(relPath) {
  const enc = encodeFilePath(relPath);
  return {
    inline_keyboard: [
      [
        { text: '📖 Read', callback_data: `file:read:${enc}` },
        { text: '✏️ Edit with Claude', callback_data: `file:edit_prompt:${enc}` },
      ],
      [
        { text: '🗑️ Delete File', callback_data: `file:delete:${enc}` },
        { text: '🔙 Back to Files', callback_data: 'zip:browse:0' },
      ],
    ],
  };
}

/**
 * After edit — approve or reject
 */
function diffApprovalKeyboard(relPath) {
  const enc = encodeFilePath(relPath);
  return {
    inline_keyboard: [
      [
        { text: '✅ Apply Changes', callback_data: `file:approve:${enc}` },
        { text: '❌ Reject', callback_data: `file:reject:${enc}` },
      ],
    ],
  };
}

/**
 * Mode selector keyboard
 */
function modeKeyboard(currentMode) {
  const modes = [
    { label: '💬 Chat', mode: 'chat' },
    { label: '💻 Code', mode: 'code' },
    { label: '🐛 Debug', mode: 'debug' },
    { label: '📖 Explain', mode: 'explain' },
  ];
  return {
    inline_keyboard: [
      modes.map((m) => ({
        text: m.mode === currentMode ? `✅ ${m.label}` : m.label,
        callback_data: `mode:${m.mode}`,
      })),
      [{ text: '🔙 Main Menu', callback_data: 'menu:home' }],
    ],
  };
}

/**
 * Project list keyboard
 */
function projectListKeyboard(projects) {
  if (!projects.length) {
    return {
      inline_keyboard: [
        [{ text: '📭 No saved projects yet', callback_data: 'noop' }],
        [{ text: '🔙 Main Menu', callback_data: 'menu:home' }],
      ],
    };
  }
  const rows = projects.map((p) => [
    { text: `📂 ${p.name} (${p.fileCount} files)`, callback_data: `project:load:${p.id}` },
    { text: '🗑️', callback_data: `project:delete:${p.id}` },
  ]);
  rows.push([{ text: '🔙 Main Menu', callback_data: 'menu:home' }]);
  return { inline_keyboard: rows };
}

/**
 * Admin keyboard
 */
function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Global Stats', callback_data: 'admin:stats' },
        { text: '👥 All Users', callback_data: 'admin:users' },
      ],
      [
        { text: '📢 Broadcast', callback_data: 'admin:broadcast_prompt' },
        { text: '🗑️ Cleanup Temp', callback_data: 'admin:cleanup' },
      ],
    ],
  };
}

/**
 * Memory management keyboard
 */
function memoryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📋 View Memories', callback_data: 'memory:list' },
        { text: '🗑️ Clear All', callback_data: 'memory:clear_confirm' },
      ],
      [{ text: '🔙 Main Menu', callback_data: 'menu:home' }],
    ],
  };
}

// Encode file path for callback_data (max 64 bytes in Telegram)
function encodeFilePath(relPath) {
  return Buffer.from(relPath).toString('base64').slice(0, 40);
}

function decodeFilePath(encoded) {
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return encoded;
  }
}

function iconFor(type) {
  if (type === 'code') return '💻';
  if (type === 'text') return '📄';
  if (type === 'zip') return '📦';
  return '📎';
}

module.exports = {
  mainMenuKeyboard,
  zipMainKeyboard,
  fileBrowserKeyboard,
  fileActionKeyboard,
  diffApprovalKeyboard,
  modeKeyboard,
  projectListKeyboard,
  adminKeyboard,
  memoryKeyboard,
  encodeFilePath,
  decodeFilePath,
};
