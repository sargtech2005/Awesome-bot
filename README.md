# 🤖 OmegaTech Claude AI Bot v2

Production-grade Telegram bot powered by **OmegaTech Claude-pro API**.

## ✨ Full Feature List

| Feature | Description |
|---|---|
| 💬 **AI Chat** | Claude with session memory, 4 modes (chat/code/debug/explain) |
| 🖼️ **Image Vision** | Analyze photos, screenshots, diagrams, UI designs, code images |
| 📁 **File Reading** | Read & analyze any text/code file |
| 📦 **ZIP IDE** | Upload ZIP → browse files → edit → generate → download |
| 🐙 **GitHub Clone** | Paste GitHub URL → auto-clone as workspace |
| 💻 **Code Generation** | Describe a project → receive ZIP of generated files |
| 🧠 **Long-term Memory** | Remembers your name, stack, preferences across sessions |
| 📂 **Named Projects** | Save ZIP workspaces to PostgreSQL, reload anytime |
| 📊 **Usage Stats** | Per-user and global statistics |
| 👮 **Admin Panel** | Dashboard, broadcast, ban/unban, auto-cleanup |
| 🔘 **Inline Keyboards** | File browser, diff approval, mode switcher — no typing needed |
| ⏰ **Auto Cleanup** | Cron job clears temp files older than 24h |
| 🛡️ **Rate Limiting** | 20 messages/minute per user |

## 📁 Structure

```
src/
├── index.js
├── handlers/
│   ├── commandHandler.js   # All /commands
│   ├── fileHandler.js      # ZIP + code files
│   ├── imageHandler.js     # Photos + image files
│   ├── callbackHandler.js  # Inline keyboard buttons
│   └── messageHandler.js  # Text routing
├── services/
│   ├── claudeService.js    # OmegaTech API + modes + memory
│   ├── userService.js      # User CRUD
│   ├── fileService.js      # Telegram download
│   ├── zipService.js       # ZIP operations
│   ├── githubService.js    # GitHub cloning
│   ├── projectService.js   # Named project sessions
│   ├── memoryService.js    # Long-term memory
│   └── statsService.js     # Usage tracking
├── middleware/
│   └── rateLimiter.js
├── jobs/
│   └── cleanupJob.js       # Hourly temp cleanup
└── utils/
    ├── db.js / logger.js / helpers.js
    └── keyboards.js        # All inline keyboard layouts
```

## 🖼️ Image Vision Setup

The bot supports **3 tiers** of image analysis:

1. **OmegaTech Vision endpoint** — used if `/Claude-vision` exists on your API
2. **Anthropic API direct** — set `ANTHROPIC_API_KEY` in `.env` (recommended)
3. **Fallback** — asks user to describe the image in text

**To enable full vision:** add to your `.env`:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### What it handles:
- 📸 Regular photos (compressed by Telegram)
- 🗂️ Image files sent as documents (uncompressed PNG/JPG/WebP)
- 🖥️ Code screenshots → transcription + explanation
- 🐛 Error/bug screenshots → diagnosis + fix
- 🎨 UI/UX mockups → design review
- 📊 Diagrams/charts → analysis
- 📝 Any image with text → OCR extraction

**Usage:** Just send a photo. Add a caption for specific instructions:
- (no caption) → general description
- `what does this code do` → code analysis
- `find the bug` → debug
- `extract all text` → OCR
- `analyze this UI` → design review

## 🚀 Deploy — Fly.io

```bash
fly auth login
fly launch
fly secrets set BOT_TOKEN="..." ADMIN_CHAT_ID="..." CLAUDE_API_BASE="..." ANTHROPIC_API_KEY="..."
fly postgres attach <your-postgres-app>
fly deploy
fly scale vm performance-2x --memory 8192
```

## 🐦 Deploy — Pterodactyl

See `requirements.txt` for the full Pterodactyl setup checklist.

**Quick steps:**
1. Node.js egg, 8GB RAM, 10GB disk
2. Upload files via SFTP
3. Set env vars in panel (see `.env.example`)
4. Console: `npm install && npx prisma migrate deploy`
5. Start command: `node src/index.js`

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token |
| `ADMIN_CHAT_ID` | ✅ | Your Telegram user ID |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `CLAUDE_API_BASE` | ✅ | OmegaTech API URL |
| `ANTHROPIC_API_KEY` | ⭐ Recommended | For native image vision |
| `MAX_FILE_SIZE_MB` | ❌ | Default: 50 |
| `MAX_MESSAGES_PER_MINUTE` | ❌ | Default: 20 |
| `LOG_LEVEL` | ❌ | Default: info |

## 📱 All Commands

```
/start       — Welcome & feature overview
/help        — Full command reference
/mode        — Switch AI mode (chat/code/debug/explain)
/reset       — Clear session & message history
/history     — Last 10 messages
/projects    — Saved project workspaces
/memory      — View/clear remembered facts
/stats       — Your usage statistics
/myid        — Your Telegram ID
/clear       — Delete your temp files
/pack        — Download current ZIP
/files       — Browse ZIP workspace

Admin only:
/admin       — Admin dashboard
/ban <id>    — Ban a user
/unban <id>  — Unban a user
/broadcast   — Message all users
/globalstats — Global bot statistics
```
