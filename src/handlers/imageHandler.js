// src/handlers/imageHandler.js
// Handles photos sent to the bot — downloads, base64-encodes, sends to Claude vision

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { getOrCreateUser, isUserBanned } = require('../services/userService');
const { getUserTempDir, splitIntoChunks, uniqueFilename } = require('../utils/helpers');
const { incrementStat } = require('../services/statsService');
const { extractAndSaveMemory } = require('../services/memoryService');
const { zipMainKeyboard } = require('../utils/keyboards');
const logger = require('../utils/logger');
const prisma = require('../utils/db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.CLAUDE_API_BASE || 'https://my-api-rzmb.onrender.com/api/ai/Claude-pro';

// Default prompts per image type (user can override with caption)
const DEFAULT_PROMPTS = {
  default: 'Describe this image in detail. What do you see? Include objects, colors, text, layout, and any notable elements.',
  code: 'This appears to be a code screenshot. Please read and transcribe all the code visible, then explain what it does.',
  error: 'This appears to be an error or bug screenshot. Identify the error, explain what caused it, and suggest how to fix it.',
  design: 'Analyze this UI/UX design. Describe the layout, components, color scheme, and give improvement suggestions.',
  diagram: 'Analyze this diagram or chart. Explain what it represents, the relationships shown, and key takeaways.',
};

function registerImageHandler(bot) {
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (await isUserBanned(userId)) return bot.sendMessage(chatId, '🚫 You are banned.');
    const dbUser = await getOrCreateUser(msg);

    const statusMsg = await bot.sendMessage(chatId, '🖼️ Processing your image...');

    try {
      // Telegram sends multiple resolutions — pick highest quality
      const photos = msg.photo;
      const bestPhoto = photos[photos.length - 1];
      const fileInfo = await bot.getFile(bestPhoto.file_id);

      // Check file size (Telegram already limits to 20MB but let's be safe)
      const fileSize = fileInfo.file_size || 0;
      if (fileSize > 20 * 1024 * 1024) {
        return bot.editMessageText('❌ Image too large (max 20MB).', { chat_id: chatId, message_id: statusMsg.message_id });
      }

      // Download image
      const userDir = await getUserTempDir(userId);
      const ext = path.extname(fileInfo.file_path) || '.jpg';
      const fileName = uniqueFilename(ext);
      const localPath = path.join(userDir, fileName);

      const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'arraybuffer', timeout: 60000 });
      await fs.writeFile(localPath, response.data);

      await bot.editMessageText('🤖 Asking Claude to analyze your image...', {
        chat_id: chatId, message_id: statusMsg.message_id,
      });

      // Convert to base64
      const imageBuffer = await fs.readFile(localPath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

      // Determine prompt — use caption if provided, else detect image type
      const userCaption = msg.caption?.trim() || '';
      const prompt = userCaption || detectPromptFromCaption(userCaption);

      // Call OmegaTech API with image
      const claudeResponse = await askClaudeWithImage(base64Image, mimeType, prompt, dbUser);

      // Save to history
      await prisma.message.create({
        data: {
          userId: dbUser.id,
          role: 'user',
          content: `[Image sent] ${userCaption || '(no caption)'}`,
          mode: dbUser.mode || 'chat',
        },
      });
      await prisma.message.create({
        data: {
          userId: dbUser.id,
          role: 'assistant',
          content: claudeResponse,
          mode: dbUser.mode || 'chat',
        },
      });

      // Extract memories from Claude's response context
      await extractAndSaveMemory(userId, dbUser.id, claudeResponse);
      await incrementStat(dbUser.id, 'totalFiles');

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      // Send response in chunks
      const chunks = splitIntoChunks(claudeResponse);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk);
      }

      // Follow-up options
      await bot.sendMessage(chatId,
        '💡 *What next?*\n• Ask a follow-up question about this image\n• Send another image\n• Say `extract text` to get all text from the image\n• Say `describe code` if it\'s a code screenshot',
        { parse_mode: 'Markdown' }
      );

      // Cleanup image file
      await fs.remove(localPath).catch(() => {});

    } catch (err) {
      logger.error(`imageHandler error for user ${userId}: ${err.message}`);
      await bot.editMessageText(
        `❌ Image analysis failed: ${err.message}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      ).catch(() => bot.sendMessage(chatId, `❌ Image analysis failed: ${err.message}`));
    }
  });

  // Handle document images (PNG/JPG sent as files, not compressed)
  bot.on('document', async (msg) => {
    const doc = msg.document;
    if (!doc) return;
    const mime = doc.mime_type || '';
    if (!mime.startsWith('image/')) return; // only handle images here, zip/files handled elsewhere

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (await isUserBanned(userId)) return;
    const dbUser = await getOrCreateUser(msg);

    const statusMsg = await bot.sendMessage(chatId, '🖼️ Processing image file (uncompressed)...');

    try {
      const fileInfo = await bot.getFile(doc.file_id);
      const userDir = await getUserTempDir(userId);
      const ext = path.extname(doc.file_name || '.jpg') || '.jpg';
      const localPath = path.join(userDir, uniqueFilename(ext));

      const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'arraybuffer', timeout: 60000 });
      await fs.writeFile(localPath, response.data);

      await bot.editMessageText('🤖 Analyzing image with Claude...', { chat_id: chatId, message_id: statusMsg.message_id });

      const imageBuffer = await fs.readFile(localPath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = mime;
      const userCaption = msg.caption?.trim() || '';
      const prompt = userCaption || DEFAULT_PROMPTS.default;

      const claudeResponse = await askClaudeWithImage(base64Image, mimeType, prompt, dbUser);

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      const chunks = splitIntoChunks(claudeResponse);
      for (const chunk of chunks) await bot.sendMessage(chatId, chunk);

      await fs.remove(localPath).catch(() => {});
    } catch (err) {
      logger.error(`imageHandler (document) error: ${err.message}`);
      await bot.editMessageText(`❌ Failed: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    }
  });

  logger.info('Image handler registered');
}

/**
 * Send image to OmegaTech Claude API as base64
 * The API accepts a prompt — we embed the base64 image data in a special format
 */
async function askClaudeWithImage(base64Image, mimeType, prompt, dbUser) {
  try {
    // Build multimodal prompt — embed image as data URI description request
    // Since the OmegaTech API is a GET endpoint with ?prompt=, we encode the image
    // and ask Claude to process it using the vision-capable model
    const imageDataUri = `data:${mimeType};base64,${base64Image}`;

    // Send via POST to the API with image payload
    const response = await axios.post(
      BASE_URL.replace('/Claude-pro', '/Claude-vision').replace('?', ''),
      {
        prompt,
        image: imageDataUri,
        sessionId: dbUser.sessionId || undefined,
      },
      { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
    ).catch(async () => {
      // Fallback: if vision endpoint doesn't exist, use the text API with image description request
      return askClaudeImageFallback(base64Image, mimeType, prompt, dbUser);
    });

    if (response && response.data && response.data.success) {
      return response.data.response;
    }

    // Fallback
    return await askClaudeImageFallback(base64Image, mimeType, prompt, dbUser);
  } catch (err) {
    logger.error(`askClaudeWithImage error: ${err.message}`);
    return await askClaudeImageFallback(base64Image, mimeType, prompt, dbUser);
  }
}

/**
 * Fallback: use Anthropic API directly for vision if available,
 * otherwise send a descriptive prompt explaining what the user sent
 */
async function askClaudeImageFallback(base64Image, mimeType, prompt, dbUser) {
  // Try direct Anthropic API with vision
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (anthropicKey) {
    return await askAnthropicVision(base64Image, mimeType, prompt, anthropicKey);
  }

  // Last resort: inform user the API doesn't support images natively
  const params = new URLSearchParams({
    prompt: `The user sent an image (${mimeType}) and wants to know: "${prompt}". Please ask them to describe the image in text so you can help, since direct image analysis requires a vision-capable endpoint.`,
  });
  if (dbUser.sessionId) params.append('sessionId', dbUser.sessionId);

  const { data } = await axios.get(`${BASE_URL}?${params.toString()}`, { timeout: 60000 });
  return data.response;
}

/**
 * Direct Anthropic API call with vision (if ANTHROPIC_API_KEY is set)
 */
async function askAnthropicVision(base64Image, mimeType, prompt, apiKey) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64Image },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    }
  );

  return response.data.content[0].text;
}

/**
 * Detect what kind of prompt to use based on user caption keywords
 */
function detectPromptFromCaption(caption) {
  const lower = caption.toLowerCase();
  if (!caption) return DEFAULT_PROMPTS.default;
  if (/code|script|function|class|syntax/.test(lower)) return DEFAULT_PROMPTS.code;
  if (/error|bug|crash|exception|fail/.test(lower)) return DEFAULT_PROMPTS.error;
  if (/design|ui|ux|layout|mockup|wireframe/.test(lower)) return DEFAULT_PROMPTS.design;
  if (/diagram|chart|graph|flow|architecture/.test(lower)) return DEFAULT_PROMPTS.diagram;
  return caption; // use the caption itself as the prompt
}

module.exports = { registerImageHandler };
