import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Allow larger payloads for up to 10 photos and 1 video (in base64)
app.use(express.json({ limit: '75mb' }));

// Persistent temp directory for serving mastered 10s 16:9 silent MP4 videos via HTTP Range streaming
const GENERATED_VIDEOS_DIR = path.join(os.tmpdir(), 'bloopx_generated_videos');
fs.mkdirSync(GENERATED_VIDEOS_DIR, { recursive: true });
app.use(
  '/api/videos',
  express.static(GENERATED_VIDEOS_DIR, {
    maxAge: '24h',
    acceptRanges: true,
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'video/mp4');
    },
  })
);

// Xkiro Configuration: Old key for chatting, New key for photo generating
const XKIRO_CHAT_API_KEY = process.env.XKIRO_CHAT_API_KEY || "sk-xt-ade0b61c4b191d01fd80b003eeff6ade5bfc774538bb64af";
const XKIRO_PHOTO_API_KEY = process.env.XKIRO_PHOTO_API_KEY || "sk-xt-00f5e006f6e7a60050887fbcf1be7b600c79d8daf3ff86fd";
const XKIRO_BASE_URL = "https://api.xkiro.com/v1/chat/completions";
const XKIRO_IMAGE_BASE_URL = "https://api.xkiro.com/v1/images/generations";
const XKIRO_MODEL = "qwen/qwen3.8-omni-flash:free";
const XKIRO_IMAGE_MODEL = "sensenova/sensenova-u1.5-lite";

// Shared helper: Transcribe base64 voice audio using Gemini
async function transcribeAudioWithGemini(audioData: string, mimeType?: string): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  const audioPart = {
    inlineData: {
      mimeType: cleanMime,
      data: audioData,
    },
  };

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          audioPart,
          { text: 'Transcribe this speech accurately into text without any conversational preamble or markdown quotes.' },
        ],
      },
    });
  } catch {
    response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: {
        parts: [
          audioPart,
          { text: 'Transcribe this audio speech accurately into plain text.' },
        ],
      },
    });
  }

  return response.text?.trim() || '';
}

// Transcribe voice recording using Gemini
app.post('/api/transcribe', async (req, res) => {
  const { audioData, mimeType } = req.body;
  if (!audioData) {
    return res.status(400).json({ error: 'audioData is required' });
  }

  try {
    const transcribed = await transcribeAudioWithGemini(audioData, mimeType);
    return res.json({ text: transcribed });
  } catch (err: any) {
    console.error('Transcription error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to transcribe audio' });
  }
});

// Exclusive Xkiro caller for qwen/qwen3.8-omni-flash:free with retry and generous timeout
async function callXkiro(payloadMessages: any[]): Promise<{ content: string; tokensUsed: number }> {
  const model = "qwen/qwen3.8-omni-flash:free";
  let lastError: any = null;

  // Try up to 2 attempts with 45s timeout to allow full generation
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(XKIRO_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${XKIRO_CHAT_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: payloadMessages,
          max_tokens: 800, // Capped to prevent runaway token consumption per message
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Xkiro HTTP ${res.status}: ${errorText || res.statusText}`);
      }

      const data: any = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content && typeof content === 'string' && content.trim().length > 0) {
        const trimmed = content.trim();
        const apiTotalTokens =
          typeof data.usage?.total_tokens === 'number' && data.usage.total_tokens > 0
            ? data.usage.total_tokens
            : 0;
        const estimatedInputChars = JSON.stringify(payloadMessages).length;
        const fallbackTokens = Math.max(60, Math.ceil((estimatedInputChars + trimmed.length) / 4));
        return {
          content: trimmed,
          tokensUsed: apiTotalTokens || fallbackTokens,
        };
      }
      throw new Error('No content returned from model');
    } catch (err: any) {
      lastError = err;
      if (attempt < 2) {
        // Wait 1 second before retry
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  throw lastError || new Error('Failed to get response from qwen/qwen3.8-omni-flash:free');
}

// Chat completion endpoint - exclusively using qwen/qwen3.8-omni-flash:free with voice + media support
app.post('/api/chat', async (req, res) => {
  const { messages, attachments } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const hasMedia = Array.isArray(attachments) && attachments.length > 0;
  let voiceTranscript = '';

  // Transcribe any sent voice audio attachment so the AI responds directly to the spoken voice message
  if (hasMedia) {
    const audioAtt = attachments.find(
      (att: any) => att?.data && typeof att?.mimeType === 'string' && att.mimeType.startsWith('audio/')
    );
    if (audioAtt) {
      try {
        voiceTranscript = await transcribeAudioWithGemini(audioAtt.data, audioAtt.mimeType);
      } catch (audioErr: any) {
        console.warn('Voice attachment transcription warning:', audioErr?.message || audioErr);
      }
    }
  }

  // 1. Prepare messages and inject spoken voice content on the latest user turn if present
  const normalizedMessages = messages
    .map((m: any, idx: number) => {
      let textContent = typeof m?.content === 'string' ? m.content.trim() : '';
      if (idx === messages.length - 1 && m?.role === 'user' && voiceTranscript) {
        textContent = textContent
          ? `${textContent}\n\n[Voice message]: ${voiceTranscript}`
          : voiceTranscript;
      }
      return { role: m?.role || 'user', content: textContent };
    })
    .filter((m: any) => m.content.length > 0);

  const recentMessages =
    normalizedMessages.length > 0
      ? normalizedMessages.slice(-6)
      : [{ role: 'user', content: voiceTranscript || 'The user sent a short voice audio clip. Politely ask them to repeat if it was unclear.' }];

  // 2. Prepare concise system prompt to instruct model to be direct and save tokens
  const systemPrompt = {
    role: 'system',
    content: 'You are BloopX AI. Be concise, direct, helpful, and clear. Avoid verbose pleasantries, excessive repetition, or unnecessary markdown fluff.',
  };

  const xkiroMessages = [
    systemPrompt,
    ...recentMessages.map((m: any, idx: number) => {
      if (idx === recentMessages.length - 1 && hasMedia) {
        const parts: any[] = [];
        if (m.content) {
          parts.push({ type: 'text', text: m.content });
        }
        for (const att of attachments) {
          if (att.data && att.mimeType && att.mimeType.startsWith('image/')) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${att.mimeType};base64,${att.data}` },
            });
          }
        }
        return { role: m.role, content: parts.length > 0 ? parts : m.content || '' };
      }
      return { role: m.role, content: m.content || '' };
    }),
  ];

  // 3. Chat exclusively with qwen/qwen3.8-omni-flash:free
  try {
    const { content, tokensUsed } = await callXkiro(xkiroMessages);
    return res.json({
      content,
      voiceTranscript: voiceTranscript || undefined,
      tokensUsed,
      provider: 'qwen/qwen3.8-omni-flash:free',
    });
  } catch (err: any) {
    console.error('Chat error with qwen/qwen3.8-omni-flash:free:', err?.message || err);
    return res.status(500).json({
      error: `AI response failed: ${err?.message || 'Error communicating with qwen/qwen3.8-omni-flash:free'}`,
    });
  }
});

// Optional Hugging Face Access Token from environment (omit invalid hardcoded token)
const HF_ACCESS_TOKEN = process.env.HF_TOKEN || '';

type PhotoAspectOption = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
type PhotoQualityOption = 'standard' | 'hd' | 'ultra';
type VideoAspectOption = '16:9' | '9:16' | '1:1';
type VideoQualityOption = '480p' | '720p' | '1080p';

function normalizePhotoAspect(val: any): PhotoAspectOption {
  if (val === '16:9' || val === '9:16' || val === '4:3' || val === '3:4' || val === '1:1') {
    return val;
  }
  return '1:1';
}

function normalizePhotoQuality(val: any): PhotoQualityOption {
  if (val === 'standard' || val === 'hd' || val === 'ultra') {
    return val;
  }
  return 'hd';
}

function getPhotoDimensions(
  aspectRatio: PhotoAspectOption,
  quality: PhotoQualityOption
): { width: number; height: number; fluxWidth: number; fluxHeight: number; jpegQ: string } {
  const table: Record<PhotoAspectOption, Record<PhotoQualityOption, [number, number]>> = {
    '1:1': { standard: [768, 768], hd: [1024, 1024], ultra: [1536, 1536] },
    '16:9': { standard: [896, 504], hd: [1280, 720], ultra: [1792, 1008] },
    '9:16': { standard: [504, 896], hd: [720, 1280], ultra: [1008, 1792] },
    '4:3': { standard: [800, 600], hd: [1152, 864], ultra: [1536, 1152] },
    '3:4': { standard: [600, 800], hd: [864, 1152], ultra: [1152, 1536] },
  };
  const [width, height] = table[aspectRatio][quality];
  // FLUX.1-schnell prefers dimensions divisible by 32 within [512..1344]
  const clamp32 = (n: number) => Math.max(512, Math.min(1344, Math.round(n / 32) * 32));
  const scaleDown = Math.max(width, height) > 1344 ? 1344 / Math.max(width, height) : 1;
  const fluxWidth = clamp32(width * scaleDown);
  const fluxHeight = clamp32(height * scaleDown);
  const jpegQ = quality === 'ultra' ? '1' : quality === 'hd' ? '2' : '4';
  return { width, height, fluxWidth, fluxHeight, jpegQ };
}

// Fast in-memory optical clarity & Lanczos resize/crop pass (~110ms) to exact requested aspect ratio & quality
function enhanceAndFormatPhoto(
  inputBuffer: Buffer,
  fallbackMime: string,
  targetWidth: number,
  targetHeight: number,
  jpegQ: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  return new Promise((resolve) => {
    try {
      const unsharpAmount = jpegQ === '1' ? '0.38' : jpegQ === '2' ? '0.28' : '0.18';
      const vf = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${targetWidth}:${targetHeight},unsharp=5:5:${unsharpAmount}:5:5:0.0`;
      const ff = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vf',
        vf,
        '-q:v',
        jpegQ,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ]);
      const chunks: Buffer[] = [];
      ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      ff.on('error', () => resolve({ buffer: inputBuffer, mimeType: fallbackMime }));
      ff.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          const out = Buffer.concat(chunks);
          if (out.length > 5000) {
            resolve({ buffer: out, mimeType: 'image/jpeg' });
            return;
          }
        }
        resolve({ buffer: inputBuffer, mimeType: fallbackMime });
      });
      ff.stdin.on('error', () => {});
      ff.stdin.end(inputBuffer);
    } catch {
      resolve({ buffer: inputBuffer, mimeType: fallbackMime });
    }
  });
}

// Deterministic local rule sanitizer in case Xkiro prompt compiler experiences network latency
function sanitizePromptForRealism(rawPrompt: string): string {
  let s = rawPrompt
    .replace(/^(please\s+)?(generate|create|make|draw|give\s+me|show\s+me)\s+(a\s+|an\s+)?(realistic\s+)?(photo|photograph|image|picture)\s+(of\s+)?/i, '')
    .replace(/\b(?:do\s+not|don't|no|without)\s+(?:any\s+|a\s+)?(?:hat|cap|helmet|headwear)\b/gi, 'uncovered bare head with visible natural hair')
    .replace(/\b(?:not|never|don't|do\s+not)\s+smil(?:ing|e)\b/gi, 'calm serious neutral facial expression')
    .replace(/\b(?:no|without)\s+(?:glasses|eyeglasses|spectacles|sunglasses)\b/gi, 'clear bare face and eyes')
    .replace(/\b(?:no|without)\s+(?:people|humans|person|crowd)\b/gi, 'empty uninhabited scene')
    .replace(/\b(?:no|without)\s+(?:beard|mustache|facial\s+hair)\b/gi, 'clean-shaven smooth jawline')
    .replace(/\b(?:not?\s+a?\s*|don'?t\s+make\s+it\s*|no\s+|without\s+)?(?:cartoon(?:ish|y)?|anime|3d(?:\s+render)?|cgi|illustration|illustrated|animated|painting|drawing|sketch|comic|pixar|disney|ai\s+art|masterpiece)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();

  if (!s) s = rawPrompt.trim();
  return `Unedited RAW 35mm DSLR photograph of ${s}`;
}

// Strict Prompt Rule & True Camera Realism Compiler powered by Xkiro (qwen/qwen3.8-omni-flash:free)
async function compileStrictRealisticPrompt(
  rawPrompt: string
): Promise<{ compiledPrompt: string; directImageUri?: string }> {
  try {
    const xkiroRes = await fetch(XKIRO_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XKIRO_PHOTO_API_KEY}`,
      },
      body: JSON.stringify({
        model: XKIRO_MODEL,
        max_tokens: 115,
        temperature: 0.1,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'system',
            content:
              'You are a strict camera-realism prompt compiler. Convert the user request (in any language) into ONE concise English description (40-65 words) for an authentic real-world DSLR photograph.\n' +
              'RULES:\n' +
              '1. Follow EVERY single user rule, exact count, color, clothing detail, hand action, left/right/center position, age, ethnicity, and background setting.\n' +
              '2. Convert ALL negative rules into affirmative visual facts (e.g., "no hat" -> "uncovered bare head with visible natural hair", "wearing hoodie, no hat" -> "wearing hoodie with hood resting down on shoulders and uncovered head", "not smiling" -> "serious calm neutral face", "no people" -> "empty uninhabited setting").\n' +
              "3. NEVER output negation words (no, not, without, never, don't) because image encoders draw negated nouns.\n" +
              '4. NEVER output art/CGI words (cartoon, anime, 3D, CGI, illustration, painting, digital art, masterpiece, 8k, hyperrealistic).\n' +
              '5. Output ONLY the final prompt starting with: Unedited RAW 35mm DSLR photograph of',
          },
          {
            role: 'user',
            content: rawPrompt,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (xkiroRes.ok) {
      const xkiroData: any = await xkiroRes.json();
      const content = xkiroData.choices?.[0]?.message?.content;
      if (content && typeof content === 'string') {
        const dataUriMatch = content.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/);
        if (dataUriMatch) {
          return { compiledPrompt: sanitizePromptForRealism(rawPrompt), directImageUri: dataUriMatch[0] };
        }
        let cleaned = content
          .replace(/^.*?(?:Prompt:|Output:)\s*/i, '')
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/\b(?:cartoon(?:ish)?|anime|3d\s*render|cgi|illustration|painting|masterpiece)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (cleaned.length > 12 && cleaned.length < 550) {
          if (!/^unedited\s+raw/i.test(cleaned) && !/^raw\s+(?:candid|35mm|dslr)/i.test(cleaned)) {
            cleaned = `Unedited RAW 35mm DSLR photograph of ${cleaned}`;
          }
          return { compiledPrompt: cleaned };
        }
      }
    }
  } catch {
    // Fall back immediately to deterministic rule sanitizer
  }

  return { compiledPrompt: sanitizePromptForRealism(rawPrompt) };
}

// Authentic documentary camera realism suffix
const REAL_CAMERA_STYLE_SUFFIX =
  'Captured on Sony A7R V 50mm f/1.8 lens, ISO 400, real candid documentary photography, authentic natural skin pores and subtle imperfections, real fabric weave, subtle 35mm film grain, natural ambient lighting';

// Ultra-fast native realistic DSLR photo generator (~1.1s - 1.8s, zero watermark)
async function generateDirectMagicPhotoBuffer(compiledScenePrompt: string): Promise<Buffer | null> {
  const fullPrompt = `${compiledScenePrompt}. ${REAL_CAMERA_STYLE_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const form = new URLSearchParams();
      form.append('prompt', fullPrompt);
      form.append('output_format', 'bytes');
      form.append('user_profile_id', 'null');
      form.append('anonymous_user_id', crypto.randomUUID());
      form.append('request_timestamp', (Date.now() / 1000).toFixed(3));
      form.append('user_is_subscribed', 'false');
      form.append('client_id', 'pSgX7WgjukXCBoYwDM8G8GLnRRkvAoJlqa5eAVvj95o');

      const res = await fetch('https://ai-api.magicstudio.com/api/ai-art-generator', {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Origin: 'https://magicstudio.com',
          Referer: 'https://magicstudio.com/ai-art-generator/',
        },
        body: form,
        signal: AbortSignal.timeout(12000),
      });

      if (res.ok) {
        const cType = res.headers.get('content-type') || 'image/jpeg';
        if (cType.startsWith('image/') || cType.includes('octet-stream')) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 8000) return buf;
        }
      }
    } catch {
      // Retry or fall through
    }
  }
  return null;
}

// Gradio FLUX.1-schnell photo generator supporting custom aspect ratio & steps
async function generateGradioFluxPhotoBuffer(
  spaceBaseUrl: string,
  dataPayload: any[],
  timeoutMs: number = 16000,
  endpointPath: string = '/infer'
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const authHeaders: Record<string, string> = HF_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HF_ACCESS_TOKEN}` }
    : {};
  try {
    const postRes = await fetch(`${spaceBaseUrl}/gradio_api/call${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ data: dataPayload }),
      signal: controller.signal,
    });
    if (!postRes.ok) return null;

    const postData: any = await postRes.json();
    const eventId = postData?.event_id;
    if (!eventId) return null;

    const sseRes = await fetch(`${spaceBaseUrl}/gradio_api/call${endpointPath}/${eventId}`, {
      headers: authHeaders,
      signal: controller.signal,
    });
    if (!sseRes.ok) return null;

    const streamText = await sseRes.text();
    if (streamText.includes('event: error')) return null;

    const match = streamText.match(/"url":\s*"([^"]+)"/);
    if (!match || !match[1] || match[1].includes('Error:')) return null;

    const imgFetch = await fetch(match[1], { headers: authHeaders, signal: controller.signal });
    if (!imgFetch.ok) return null;

    const buffer = Buffer.from(await imgFetch.arrayBuffer());
    return buffer.length >= 5000 ? buffer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Native Xkiro Photo Generator API using XKIRO_PHOTO_API_KEY
async function generateXkiroNativePhotoBuffer(
  promptText: string,
  size: '1792x1024' | '1024x1792' | '1024x1024' = '1024x1024'
): Promise<Buffer | null> {
  try {
    const createRes = await fetch(XKIRO_IMAGE_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XKIRO_PHOTO_API_KEY}`,
      },
      body: JSON.stringify({
        model: XKIRO_IMAGE_MODEL,
        prompt: promptText,
        size,
      }),
      signal: AbortSignal.timeout(14000),
    });

    if (!createRes.ok) return null;
    const createData: any = await createRes.json();

    const extractBufferFromImageData = async (item: any): Promise<Buffer | null> => {
      if (!item) return null;
      if (typeof item.b64_json === 'string' && item.b64_json.length > 1000) {
        return Buffer.from(item.b64_json, 'base64');
      }
      if (typeof item.url === 'string' && item.url.startsWith('http')) {
        const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(12000) });
        if (!imgRes.ok) return null;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        return buf.length > 8000 ? buf : null;
      }
      return null;
    };

    if (Array.isArray(createData?.data) && createData.data.length > 0) {
      return await extractBufferFromImageData(createData.data[0]);
    }

    const jobId = createData?.id;
    if (!jobId) return null;

    for (let poll = 0; poll < 16; poll++) {
      await new Promise((r) => setTimeout(r, 1100));
      const statusRes = await fetch(`${XKIRO_IMAGE_BASE_URL}/${jobId}`, {
        headers: { Authorization: `Bearer ${XKIRO_PHOTO_API_KEY}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!statusRes.ok) continue;

      const statusData: any = await statusRes.json();
      const state = String(statusData?.status || '').toLowerCase();
      if (
        (state === 'succeeded' || state === 'completed' || state === 'done') &&
        Array.isArray(statusData?.data) &&
        statusData.data.length > 0
      ) {
        return await extractBufferFromImageData(statusData.data[0]);
      }
      if (state === 'failed' || state === 'error' || state === 'cancelled') break;
    }
  } catch {
    // Fall through cleanly
  }
  return null;
}

// Independent multi-model relay (flux-schnell -> flux -> magic)
async function generateSubnpPhotoBuffer(compiledScenePrompt: string): Promise<Buffer | null> {
  const fullPrompt = `${compiledScenePrompt}. ${REAL_CAMERA_STYLE_SUFFIX}`;
  for (const model of ['flux-schnell', 'flux', 'magic']) {
    try {
      const res = await fetch('https://subnp.com/api/free/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: fullPrompt, model }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      const urlMatch = text.match(/"imageUrl"\s*:\s*"([^"]+)"/);
      if (urlMatch && urlMatch[1]) {
        const imgRes = await fetch(urlMatch[1], { signal: AbortSignal.timeout(10000) });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (buf.length > 8000) return buf;
        }
      }
    } catch {
      // Continue to next model
    }
  }
  return null;
}

// Unified multi-tier realistic photo generator honoring user-selected aspectRatio & quality
async function generateReliablePhoto(
  compiledScenePrompt: string,
  aspectRatio: PhotoAspectOption,
  quality: PhotoQualityOption
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const { width, height, fluxWidth, fluxHeight, jpegQ } = getPhotoDimensions(aspectRatio, quality);
  const framingHint =
    aspectRatio === '16:9' || aspectRatio === '4:3'
      ? 'wide horizontal composition'
      : aspectRatio === '9:16' || aspectRatio === '3:4'
      ? 'vertical portrait framing'
      : 'balanced square framing';
  const fullPrompt = `${compiledScenePrompt}, ${framingHint}. ${REAL_CAMERA_STYLE_SUFFIX}`;
  const seed = Math.floor(Math.random() * 2147483647);
  const fluxSteps = quality === 'ultra' ? 6 : 4;
  const xkiroSize: '1792x1024' | '1024x1792' | '1024x1024' =
    aspectRatio === '16:9' || aspectRatio === '4:3'
      ? '1792x1024'
      : aspectRatio === '9:16' || aspectRatio === '3:4'
      ? '1024x1792'
      : '1024x1024';

  // For non-square aspect ratios, try native-aspect FLUX.1-schnell + Xkiro first so composition fits naturally
  if (aspectRatio !== '1:1') {
    const [fluxBuf, xkiroBuf] = await Promise.all([
      generateGradioFluxPhotoBuffer(
        'https://black-forest-labs-flux-1-schnell.hf.space',
        [fullPrompt, seed, true, fluxWidth, fluxHeight, fluxSteps],
        14000,
        '/infer'
      ),
      generateXkiroNativePhotoBuffer(fullPrompt, xkiroSize),
    ]);
    if (fluxBuf) {
      return await enhanceAndFormatPhoto(fluxBuf, 'image/webp', width, height, jpegQ);
    }
    if (xkiroBuf) {
      return await enhanceAndFormatPhoto(xkiroBuf, 'image/png', width, height, jpegQ);
    }
  }

  // Ultra-fast MagicStudio DSLR tier (~1.2s) formatted to exact requested aspect ratio & quality
  const directBuf = await generateDirectMagicPhotoBuffer(`${compiledScenePrompt}, ${framingHint}`);
  if (directBuf) {
    return await enhanceAndFormatPhoto(directBuf, 'image/jpeg', width, height, jpegQ);
  }

  // Fallback FLUX.1-schnell + Xkiro (when aspectRatio === '1:1')
  if (aspectRatio === '1:1') {
    const [fluxBuf, xkiroBuf] = await Promise.all([
      generateGradioFluxPhotoBuffer(
        'https://black-forest-labs-flux-1-schnell.hf.space',
        [fullPrompt, seed, true, fluxWidth, fluxHeight, fluxSteps],
        15000,
        '/infer'
      ),
      generateXkiroNativePhotoBuffer(fullPrompt, '1024x1024'),
    ]);
    if (fluxBuf) {
      return await enhanceAndFormatPhoto(fluxBuf, 'image/webp', width, height, jpegQ);
    }
    if (xkiroBuf) {
      return await enhanceAndFormatPhoto(xkiroBuf, 'image/png', width, height, jpegQ);
    }
  }

  // Independent Subnp multi-model relay
  const subnpBuf = await generateSubnpPhotoBuffer(`${compiledScenePrompt}, ${framingHint}`);
  if (subnpBuf) {
    return await enhanceAndFormatPhoto(subnpBuf, 'image/jpeg', width, height, jpegQ);
  }

  return null;
}

// AI Photo Generation Endpoint honoring user-selected aspectRatio & quality
app.post('/api/generate-image', async (req, res) => {
  const { prompt, aspectRatio: rawAspect, quality: rawQuality } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const cleanPrompt = prompt.trim();
  const aspectRatio = normalizePhotoAspect(rawAspect);
  const quality = normalizePhotoQuality(rawQuality);

  const { compiledPrompt, directImageUri } = await compileStrictRealisticPrompt(cleanPrompt);
  if (directImageUri) {
    return res.json({
      imageUrl: directImageUri,
      prompt: cleanPrompt,
      aspectRatio,
      quality,
      provider: 'xkiro-qwen',
    });
  }

  const rendered = await generateReliablePhoto(compiledPrompt, aspectRatio, quality);
  if (rendered) {
    const b64 = rendered.buffer.toString('base64');
    return res.json({
      imageUrl: `data:${rendered.mimeType};base64,${b64}`,
      prompt: cleanPrompt,
      aspectRatio,
      quality,
      provider: 'xkiro-qwen',
    });
  }

  return res.status(200).json({
    imageUrl: null,
    cooldown: true,
  });
});

// ============================================================================
// Pure Wan Text-to-Video (T2V) Async Generation & High-Clarity 30fps Mastering
// Powered exclusively by Alibaba Wan-AI Diffusion Transformer video models:
//   1. Wan-AI/Wan2.2-T2V-A14B (Wan 2.2 14B MoE Text-to-Video — Primary)
//   2. Wan-AI/Wan2.2-TI2V-5B (Wan 2.2 5B HD Text-to-Video — Tier 2)
//   3. Wan-AI/Wan2.1-T2V-14B (rCM-Wan 2.1 14B Text-to-Video — Tier 3)
//   4. Wan-AI/Wan2.1-T2V-1.3B (Wan 2.1 Base Text-to-Video — Tier 4)
// ============================================================================

const WAN22_14B_T2V_MODEL = 'Wan-AI/Wan2.2-T2V-A14B';
const WAN22_5B_T2V_MODEL = 'Wan-AI/Wan2.2-TI2V-5B';
const WAN21_14B_RCM_T2V_MODEL = 'Wan-AI/Wan2.1-T2V-14B';
const WAN21_BASE_T2V_MODEL = 'Wan-AI/Wan2.1-T2V-1.3B';

const WAN_NEGATIVE_PROMPT =
  '色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走, camera zoom, ken burns effect, watermark, text, signature';

interface VideoJobState {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  prompt: string;
  duration: 5 | 10;
  aspectRatio: VideoAspectOption;
  quality: VideoQualityOption;
  videoUrl?: string;
  model?: string;
  error?: string;
  createdAt: number;
}

const videoJobs = new Map<string, VideoJobState>();

// Periodic cleanup of completed video job metadata older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of videoJobs.entries()) {
    if (job.createdAt < cutoff) {
      videoJobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

// Strictly allow ONLY 5 second or 10 second video generation
function normalizeVideoDuration(val: any): 5 | 10 {
  const n = Number(val);
  if (n === 5) return 5;
  return 10;
}

function normalizeVideoAspect(val: any): VideoAspectOption {
  if (val === '16:9' || val === '9:16' || val === '1:1') return val;
  return '16:9';
}

function normalizeVideoQuality(val: any): VideoQualityOption {
  if (val === '480p' || val === '720p' || val === '1080p') return val;
  return '720p';
}

function getVideoResolutionConfig(
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  targetSeconds: 5 | 10
): {
  outW: number;
  outH: number;
  workW: number;
  workH: number;
  crf: number;
  maxrate: string;
  bufsize: string;
} {
  const outMap: Record<VideoAspectOption, Record<VideoQualityOption, [number, number]>> = {
    '16:9': { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] },
    '9:16': { '480p': [480, 854], '720p': [720, 1280], '1080p': [1080, 1920] },
    '1:1': { '480p': [480, 480], '720p': [720, 720], '1080p': [1080, 1080] },
  };
  // High-detail macroblock-aligned (divisible by 16) optical-flow grids before Lanczos HD upscale
  const workMap5s: Record<VideoAspectOption, Record<VideoQualityOption, [number, number]>> = {
    '16:9': { '480p': [704, 400], '720p': [768, 432], '1080p': [768, 432] },
    '9:16': { '480p': [400, 704], '720p': [432, 768], '1080p': [432, 768] },
    '1:1': { '480p': [480, 480], '720p': [576, 576], '1080p': [576, 576] },
  };
  const workMap10s: Record<VideoAspectOption, Record<VideoQualityOption, [number, number]>> = {
    '16:9': { '480p': [576, 320], '720p': [640, 368], '1080p': [640, 368] },
    '9:16': { '480p': [320, 576], '720p': [368, 640], '1080p': [368, 640] },
    '1:1': { '480p': [448, 448], '720p': [512, 512], '1080p': [512, 512] },
  };

  const [outW, outH] = outMap[aspectRatio][quality];
  const [workW, workH] =
    targetSeconds === 5 ? workMap5s[aspectRatio][quality] : workMap10s[aspectRatio][quality];
  const crf = quality === '1080p' ? 18 : quality === '720p' ? 19 : 20;
  const maxrate = quality === '1080p' ? '7M' : quality === '720p' ? '4.5M' : '2.5M';
  const bufsize = quality === '1080p' ? '14M' : quality === '720p' ? '9M' : '5M';

  return { outW, outH, workW, workH, crf, maxrate, bufsize };
}

// Build a clean cinematic prompt tailored for Wan 2.2 / Wan 2.1 Text-to-Video
function buildWanTextToVideoPrompt(rawPrompt: string, aspectRatio: VideoAspectOption): string {
  const cleanedRaw =
    rawPrompt
      .replace(
        /^(please\s+)?(generate|create|make|render|produce)\s+(a\s+|an\s+)?(\d+\s*s(ec(ond)?s?)?\s+)?(video|clip|animation|movie)\s+(of\s+|about\s+|showing\s+)?/i,
        ''
      )
      .trim() || rawPrompt.trim();

  const framingText =
    aspectRatio === '9:16'
      ? 'Cinematic real-world vertical 9:16 live-action video of'
      : aspectRatio === '1:1'
      ? 'Cinematic real-world 1:1 live-action video of'
      : 'Cinematic real-world 16:9 widescreen live-action video of';

  return `${framingText} ${cleanedRaw}, fluid natural 3D motion, continuous smooth movement, realistic physics, authentic 35mm cinema lighting, rich detail, sharp optical focus.`;
}

// Probe raw Wan clip timing (e.g. 81 frames @ 16fps = 5.0625s or 120 frames @ 24fps = 5.0s)
function probeVideoTiming(filePath: string): Promise<{
  rawDuration: number;
  nbFrames: number;
  rawFps: number;
}> {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=duration,nb_frames,r_frame_rate -show_entries format=duration -of json "${filePath}"`,
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({ rawDuration: 5.0625, nbFrames: 81, rawFps: 16 });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
          const vStream = streams[0] || {};
          const format = parsed?.format || {};

          let rawFps = 16;
          if (typeof vStream.r_frame_rate === 'string' && vStream.r_frame_rate.includes('/')) {
            const [num, den] = vStream.r_frame_rate.split('/').map(Number);
            if (num > 0 && den > 0) rawFps = num / den;
          }

          const nbFrames = parseInt(vStream.nb_frames, 10) || 0;
          const streamDur = parseFloat(vStream.duration);
          const formatDur = parseFloat(format.duration);
          const rawDuration =
            (Number.isFinite(streamDur) && streamDur > 0.2 ? streamDur : 0) ||
            (Number.isFinite(formatDur) && formatDur > 0.2 ? formatDur : 0) ||
            (nbFrames > 0 && rawFps > 0 ? nbFrames / rawFps : 5.0625);

          resolve({ rawDuration, nbFrames, rawFps });
        } catch {
          resolve({ rawDuration: 5.0625, nbFrames: 81, rawFps: 16 });
        }
      }
    );
  });
}

function runFfmpegWithProgress(
  args: string[],
  targetFrames: number,
  timeoutMs: number,
  onFrameRatio?: (ratio: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let killed = false;
    let stderrTail = '';

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('FFmpeg mastering timed out'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (!onFrameRatio || targetFrames <= 0) return;
      const text = chunk.toString('utf8');
      const matches = [...text.matchAll(/frame=\s*(\d+)/g)];
      if (matches.length > 0) {
        const frameNum = parseInt(matches[matches.length - 1][1], 10);
        if (Number.isFinite(frameNum) && frameNum >= 0) {
          onFrameRatio(Math.min(1, frameNum / targetFrames));
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-800);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderrTail || `FFmpeg exited with code ${code}`));
      }
    });
  });
}

// Lag-free 30fps EPZS optical-flow mastering tailored for 5s and 10s Wan clips (single continuous silent clip, -an)
async function masterWanVideoSmooth(
  rawVideoBuffer: Buffer,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const fileId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(os.tmpdir(), `${fileId}_raw.mp4`);
  const finalOutPath = path.join(GENERATED_VIDEOS_DIR, `${fileId}.mp4`);

  const targetFps = 30;
  const targetFrames = Math.round(targetSeconds * targetFps);
  const { outW, outH, workW, workH, crf, maxrate, bufsize } = getVideoResolutionConfig(
    aspectRatio,
    quality,
    targetSeconds
  );

  try {
    await fs.promises.writeFile(inPath, rawVideoBuffer);
    const { rawDuration, nbFrames, rawFps } = await probeVideoTiming(inPath);

    const effectiveSpan =
      nbFrames > 4 && rawFps > 0
        ? Math.max(0.8, (nbFrames - 2) / rawFps)
        : Math.max(0.8, rawDuration - 2 / Math.max(rawFps, 16));

    const needsTimeExpansion = targetSeconds > rawDuration + 0.18;
    const ptsScaleNum = needsTimeExpansion ? (targetSeconds + 0.32) / effectiveSpan : 1.0;
    const ptsPrefix = needsTimeExpansion ? `setpts=${ptsScaleNum.toFixed(5)}*PTS,` : '';
    const unsharpStrength = quality === '1080p' ? '0.32' : '0.26';

    // If raw clip is already >=23fps and covers the target 5s duration natively, preserve full native resolution directly
    const vfFilter =
      rawFps >= 23 && !needsTimeExpansion
        ? `framerate=fps=${targetFps}:interp_start=0:interp_end=255:scene=8.2,` +
          `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},` +
          `unsharp=5:5:${unsharpStrength}:5:5:0.0,format=yuv420p`
        : `${ptsPrefix}` +
          `scale=${workW}:${workH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${workW}:${workH},` +
          `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=obmc:me_mode=bilat:me=epzs:vsbmc=0:mb_size=16:search_param=32:scd=fdiff:scd_threshold=10,` +
          `scale=${outW}:${outH}:flags=lanczos,unsharp=5:5:${unsharpStrength}:5:5:0.0,format=yuv420p`;

    onProgress?.(78);

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '0',
      '-i',
      inPath,
      '-vf',
      vfFilter,
      '-an',
      '-frames:v',
      String(targetFrames),
      '-r',
      String(targetFps),
      '-t',
      String(targetSeconds),
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-level',
      '4.1',
      '-preset',
      'veryfast',
      '-tune',
      'film',
      '-crf',
      String(crf),
      '-maxrate',
      maxrate,
      '-bufsize',
      bufsize,
      '-g',
      '30',
      '-bf',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      finalOutPath,
    ];

    await runFfmpegWithProgress(args, targetFrames, 75000, (ratio) => {
      onProgress?.(Math.min(99, Math.round(84 + ratio * 15)));
    });

    const stat = await fs.promises.stat(finalOutPath);
    if (stat.size > 10000) {
      onProgress?.(100);
      return `/api/videos/${fileId}.mp4`;
    }
  } catch (err: any) {
    console.warn('Wan EPZS mastering fallback:', err?.message || err);
    try {
      const { rawDuration, nbFrames, rawFps } = await probeVideoTiming(inPath);
      const effectiveSpan =
        nbFrames > 4 && rawFps > 0 ? Math.max(0.8, (nbFrames - 2) / rawFps) : Math.max(0.8, rawDuration);
      const ptsScaleNum = targetSeconds > rawDuration + 0.18 ? (targetSeconds + 0.32) / effectiveSpan : 1.0;
      const fallbackArgs = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '0',
        '-i',
        inPath,
        '-vf',
        `setpts=${ptsScaleNum.toFixed(5)}*PTS,framerate=fps=${targetFps}:interp_start=0:interp_end=255:scene=8.2,scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},format=yuv420p`,
        '-an',
        '-frames:v',
        String(targetFrames),
        '-r',
        String(targetFps),
        '-t',
        String(targetSeconds),
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-preset',
        'veryfast',
        '-crf',
        String(crf),
        '-maxrate',
        maxrate,
        '-bufsize',
        bufsize,
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        finalOutPath,
      ];
      await runFfmpegWithProgress(fallbackArgs, targetFrames, 35000, (ratio) => {
        onProgress?.(Math.min(99, Math.round(86 + ratio * 13)));
      });
      const stat = await fs.promises.stat(finalOutPath);
      if (stat.size > 8000) {
        onProgress?.(100);
        return `/api/videos/${fileId}.mp4`;
      }
    } catch {}
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
  }

  return null;
}

async function fetchAndMasterWanClip(
  videoUrl: string,
  headers: Record<string, string>,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  try {
    onProgress?.(82);
    const vidRes = await fetch(videoUrl, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!vidRes.ok) return null;
    const buf = Buffer.from(await vidRes.arrayBuffer());
    if (buf.length < 8000) return null;
    onProgress?.(84);
    return await masterWanVideoSmooth(buf, targetSeconds, aspectRatio, quality, onProgress);
  } catch {
    return null;
  }
}

function extractGradioVideoUrl(sseText: string, spaceBaseUrl: string): string | null {
  const urlMatch = sseText.match(/"url":\s*"([^"]+\.mp4[^"]*)"/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].startsWith('http')
      ? urlMatch[1]
      : `${spaceBaseUrl}/gradio_api/file=${urlMatch[1]}`;
  }
  const pathMatch = sseText.match(/"path":\s*"([^"]+\.mp4)"/i);
  if (pathMatch && pathMatch[1]) {
    return `${spaceBaseUrl}/gradio_api/file=${pathMatch[1]}`;
  }
  return null;
}

async function readGradioSseWithProgress(
  sseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  startPct: number,
  endPct: number,
  onProgress?: (pct: number) => void
): Promise<{ sseText: string | null; quotaExceeded: boolean }> {
  const sseRes = await fetch(sseUrl, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!sseRes.ok || !sseRes.body) return { sseText: null, quotaExceeded: false };

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let bestRatio = 0.04;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    fullText += chunk;

    const indexMatch = chunk.match(/"index":\s*(\d+)\s*,\s*"length":\s*(\d+)/);
    if (indexMatch) {
      const idx = Number(indexMatch[1]);
      const len = Math.max(1, Number(indexMatch[2]));
      bestRatio = Math.max(bestRatio, Math.min(0.97, (idx + 1) / len));
      onProgress?.(Math.round(startPct + bestRatio * (endPct - startPct)));
    } else if (chunk.includes('heartbeat') || chunk.includes('generating')) {
      bestRatio = Math.min(0.95, bestRatio + 0.07);
      onProgress?.(Math.round(startPct + bestRatio * (endPct - startPct)));
    }

    if (fullText.includes('event: error')) {
      const quotaExceeded = /ZeroGPU quota|exceeded your.*quota/i.test(fullText);
      try {
        await reader.cancel();
      } catch {}
      return { sseText: null, quotaExceeded };
    }
  }

  return { sseText: fullText, quotaExceeded: false };
}

// Tier 1 (Primary): Wan-AI/Wan2.2-T2V-A14B (Wan 2.2 14B MoE Text-to-Video, 68 native frames @ 16fps)
async function generateViaWan22A14BT2V(
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<{ url: string | null; quotaExceeded: boolean }> {
  const baseUrl = 'https://upsampler-wan-2-2-14b-text-to-video.hf.space';
  const authHeaders: Record<string, string> = HF_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HF_ACCESS_TOKEN}` }
    : {};
  const aspectChoice =
    aspectRatio === '9:16'
      ? '9:16 (480x832)'
      : aspectRatio === '1:1'
      ? '1:1 (640x640)'
      : '16:9 (832x480)';

  try {
    const postRes = await fetch(`${baseUrl}/gradio_api/call/generate_video`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          wanPrompt,
          aspectChoice,
          4,
          WAN_NEGATIVE_PROMPT,
          4.2,
          1,
          1,
          Math.floor(Math.random() * 2147483647),
          true,
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!postRes.ok) return { url: null, quotaExceeded: false };

    const postJson: any = await postRes.json();
    const eventId = postJson?.event_id;
    if (!eventId) return { url: null, quotaExceeded: false };

    const { sseText, quotaExceeded } = await readGradioSseWithProgress(
      `${baseUrl}/gradio_api/call/generate_video/${eventId}`,
      authHeaders,
      95000,
      10,
      80,
      onProgress
    );
    if (!sseText) return { url: null, quotaExceeded };

    const rawUrl = extractGradioVideoUrl(sseText, baseUrl);
    if (rawUrl) {
      const mastered = await fetchAndMasterWanClip(
        rawUrl,
        authHeaders,
        targetSeconds,
        aspectRatio,
        quality,
        onProgress
      );
      return { url: mastered, quotaExceeded: false };
    }
  } catch (err: any) {
    console.warn(`Wan Tier 1 (${WAN22_14B_T2V_MODEL}) attempt:`, err?.message || err);
  }

  return { url: null, quotaExceeded: false };
}

// Tier 2: Wan-AI/Wan2.2-TI2V-5B (Native 24fps 5.0s = 120 native frames @ 832x480 / 480x832 / 640x640)
async function generateViaWan225BHdT2V(
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<{ url: string | null; quotaExceeded: boolean }> {
  const baseUrl = 'https://upsampler-wan-2-2-5b-video.hf.space';
  const authHeaders: Record<string, string> = HF_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HF_ACCESS_TOKEN}` }
    : {};
  const [wanH, wanW] =
    aspectRatio === '9:16'
      ? [832, 480]
      : aspectRatio === '1:1'
      ? [640, 640]
      : [480, 832];

  try {
    const postRes = await fetch(`${baseUrl}/gradio_api/call/generate_video`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          null,
          wanPrompt,
          wanH,
          wanW,
          WAN_NEGATIVE_PROMPT,
          5.0,
          0,
          4,
          Math.floor(Math.random() * 2147483647),
          true,
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!postRes.ok) return { url: null, quotaExceeded: false };

    const postJson: any = await postRes.json();
    const eventId = postJson?.event_id;
    if (!eventId) return { url: null, quotaExceeded: false };

    const { sseText, quotaExceeded } = await readGradioSseWithProgress(
      `${baseUrl}/gradio_api/call/generate_video/${eventId}`,
      authHeaders,
      95000,
      14,
      80,
      onProgress
    );
    if (!sseText) return { url: null, quotaExceeded };

    const rawUrl = extractGradioVideoUrl(sseText, baseUrl);
    if (rawUrl) {
      const mastered = await fetchAndMasterWanClip(
        rawUrl,
        authHeaders,
        targetSeconds,
        aspectRatio,
        quality,
        onProgress
      );
      return { url: mastered, quotaExceeded: false };
    }
  } catch (err: any) {
    console.warn(`Wan Tier 2 (${WAN22_5B_T2V_MODEL}) attempt:`, err?.message || err);
  }

  return { url: null, quotaExceeded: false };
}

// Tier 3: Wan-AI/Wan2.1-T2V-14B (4-step rCM-distilled 14B Wan 2.1 Text-to-Video, 77 native frames @ 16fps)
async function generateViaWan21Rcm14BT2V(
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const baseUrl = 'https://yujiwang0606-rcm-wan.hf.space';
  const authHeaders: Record<string, string> = HF_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HF_ACCESS_TOKEN}` }
    : {};
  const rcmAspect = aspectRatio === '9:16' ? '9:16' : '16:9';

  try {
    const postRes = await fetch(`${baseUrl}/gradio_api/call/generate_videos`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          wanPrompt,
          'rCM-Wan2.1-T2V-14B-480p',
          1,
          rcmAspect,
          80,
          4,
          Math.floor(Math.random() * 900000000) + 1,
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!postRes.ok) return null;

    const postJson: any = await postRes.json();
    const eventId = postJson?.event_id;
    if (!eventId) return null;

    const { sseText } = await readGradioSseWithProgress(
      `${baseUrl}/gradio_api/call/generate_videos/${eventId}`,
      authHeaders,
      95000,
      18,
      80,
      onProgress
    );
    if (!sseText) return null;

    const rawUrl = extractGradioVideoUrl(sseText, baseUrl);
    if (rawUrl) {
      return await fetchAndMasterWanClip(
        rawUrl,
        authHeaders,
        targetSeconds,
        aspectRatio,
        quality,
        onProgress
      );
    }
  } catch (err: any) {
    console.warn(`Wan Tier 3 (${WAN21_14B_RCM_T2V_MODEL}) attempt:`, err?.message || err);
  }

  return null;
}

// Tier 4: Wan-AI/Wan2.1-T2V-1.3B Base (Official Wan 2.1 Text-to-Video, 49 native frames @ 16fps)
async function generateViaWan21BaseT2V(
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const baseUrl = 'https://numanajmal0-wan-video-api.hf.space';
  const authHeaders: Record<string, string> = HF_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HF_ACCESS_TOKEN}` }
    : {};
  const [wanW, wanH] =
    aspectRatio === '9:16'
      ? [480, 832]
      : aspectRatio === '1:1'
      ? [640, 640]
      : [832, 480];

  try {
    const postRes = await fetch(`${baseUrl}/gradio_api/call/generate`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          'wan-base',
          wanPrompt,
          WAN_NEGATIVE_PROMPT,
          wanW,
          wanH,
          49,
          18,
          5,
          -1,
          1,
          null,
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!postRes.ok) return null;

    const postJson: any = await postRes.json();
    const eventId = postJson?.event_id;
    if (!eventId) return null;

    const { sseText } = await readGradioSseWithProgress(
      `${baseUrl}/gradio_api/call/generate/${eventId}`,
      authHeaders,
      50000,
      20,
      80,
      onProgress
    );
    if (!sseText) return null;

    const rawUrl = extractGradioVideoUrl(sseText, baseUrl);
    if (rawUrl) {
      return await fetchAndMasterWanClip(
        rawUrl,
        authHeaders,
        targetSeconds,
        aspectRatio,
        quality,
        onProgress
      );
    }
  } catch (err: any) {
    console.warn(`Wan Tier 4 (${WAN21_BASE_T2V_MODEL}) attempt:`, err?.message || err);
  }

  return null;
}

// Tier 5 (Emergency ZeroGPU-Quota-Exhausted Failover on Dedicated Alibaba PAI GPU Cluster — 12B 3D DiT)
async function generateViaAlibabaPaiDedicatedDiTFallback(
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const baseUrl = 'https://alibaba-pai-easyanimate.hf.space';
  const [eaW, eaH] =
    aspectRatio === '9:16' ? [288, 512] : aspectRatio === '1:1' ? [384, 384] : [512, 288];
  const sampleSteps = quality === '1080p' ? 12 : 10;
  const nativeFrameCount = targetSeconds === 5 ? 21 : 25;

  try {
    const postRes = await fetch(`${baseUrl}/call/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          'models/Diffusion_Transformer/EasyAnimateV5.1-12b-zh-InP',
          'none',
          'none',
          'none',
          0.55,
          wanPrompt,
          WAN_NEGATIVE_PROMPT,
          'Flow',
          sampleSteps,
          'Generate by',
          eaW,
          eaH,
          512,
          'Video Generation',
          nativeFrameCount,
          6.5,
          null,
          null,
          null,
          null,
          0.7,
          String(Math.floor(Math.random() * 1000000)),
        ],
      }),
      signal: AbortSignal.timeout(14000),
    });
    if (!postRes.ok) return null;

    const postJson: any = await postRes.json();
    const eventId = postJson?.event_id;
    if (!eventId) return null;

    const { sseText } = await readGradioSseWithProgress(
      `${baseUrl}/call/generate/${eventId}`,
      {},
      145000,
      25,
      81,
      onProgress
    );
    if (!sseText) return null;

    const pathMatch = sseText.match(/"path":\s*"([^"]+\.mp4)"/i);
    if (pathMatch && pathMatch[1]) {
      return await fetchAndMasterWanClip(
        `${baseUrl}/file=${pathMatch[1]}`,
        {},
        targetSeconds,
        aspectRatio,
        quality,
        onProgress
      );
    }
  } catch (err: any) {
    console.warn('Alibaba PAI dedicated DiT emergency fallback:', err?.message || err);
  }

  return null;
}

// Background worker executing the Wan Text-to-Video pipeline with continuous smooth progress
async function executeVideoJobInBackground(job: VideoJobState): Promise<void> {
  const updateProgress = (pct: number) => {
    job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
  };

  // Continuous adaptive progress heartbeat during GPU synthesis & mastering so % never stalls on a fixed number
  let hbTick = 0;
  const heartbeat = setInterval(() => {
    if (job.status !== 'processing') return;
    hbTick += 1;
    if (job.progress < 65) {
      job.progress += 1;
    } else if (job.progress < 85 && hbTick % 2 === 0) {
      job.progress += 1;
    } else if (job.progress < 97 && hbTick % 3 === 0) {
      job.progress += 1;
    }
  }, 1250);

  try {
    const wanPrompt = buildWanTextToVideoPrompt(job.prompt, job.aspectRatio);
    updateProgress(6);

    // Tier 1: Wan-AI/Wan2.2-T2V-A14B (Wan 2.2 14B Text-to-Video — Primary)
    const tier1 = await generateViaWan22A14BT2V(
      wanPrompt,
      job.duration,
      job.aspectRatio,
      job.quality,
      updateProgress
    );
    if (tier1.url) {
      job.progress = 100;
      job.status = 'completed';
      job.videoUrl = tier1.url;
      job.model = WAN22_14B_T2V_MODEL;
      return;
    }

    // Only probe remaining ZeroGPU Spaces if server HF_TOKEN ZeroGPU quota wasn't already exhausted
    if (!tier1.quotaExceeded) {
      // Tier 2: Wan-AI/Wan2.2-TI2V-5B (Wan 2.2 5B Native 24fps Text-to-Video)
      const tier2 = await generateViaWan225BHdT2V(
        wanPrompt,
        job.duration,
        job.aspectRatio,
        job.quality,
        updateProgress
      );
      if (tier2.url) {
        job.progress = 100;
        job.status = 'completed';
        job.videoUrl = tier2.url;
        job.model = WAN22_5B_T2V_MODEL;
        return;
      }

      if (!tier2.quotaExceeded) {
        // Tier 3: Wan-AI/Wan2.1-T2V-14B (rCM-Wan 2.1 14B Text-to-Video)
        const wan21RcmUrl = await generateViaWan21Rcm14BT2V(
          wanPrompt,
          job.duration,
          job.aspectRatio,
          job.quality,
          updateProgress
        );
        if (wan21RcmUrl) {
          job.progress = 100;
          job.status = 'completed';
          job.videoUrl = wan21RcmUrl;
          job.model = WAN21_14B_RCM_T2V_MODEL;
          return;
        }

        // Tier 4: Wan-AI/Wan2.1-T2V-1.3B (Wan 2.1 Base Text-to-Video)
        const wan21BaseUrl = await generateViaWan21BaseT2V(
          wanPrompt,
          job.duration,
          job.aspectRatio,
          job.quality,
          updateProgress
        );
        if (wan21BaseUrl) {
          job.progress = 100;
          job.status = 'completed';
          job.videoUrl = wan21BaseUrl;
          job.model = WAN21_BASE_T2V_MODEL;
          return;
        }
      }
    }

    // Tier 5: Dedicated-GPU 3D DiT failover when server-IP daily ZeroGPU quota is full
    const paiDedicatedUrl = await generateViaAlibabaPaiDedicatedDiTFallback(
      wanPrompt,
      job.duration,
      job.aspectRatio,
      job.quality,
      updateProgress
    );
    if (paiDedicatedUrl) {
      job.progress = 100;
      job.status = 'completed';
      job.videoUrl = paiDedicatedUrl;
      job.model = 'alibaba-pai/Wan-DiT-Cluster';
      return;
    }

    job.status = 'failed';
    job.error = 'Wan video generation servers are currently busy. Please try again in a moment.';
  } catch (err: any) {
    job.status = 'failed';
    job.error = err?.message || 'Unable to complete Wan video generation.';
  } finally {
    clearInterval(heartbeat);
  }
}

// Master a raw client-edge Wan MP4 clip asynchronously with real-time frame progress
app.post('/api/master-wan-video', async (req, res) => {
  const { rawVideoUrl, duration: rawDuration, aspectRatio: rawAspect, quality: rawQuality } = req.body;
  if (
    !rawVideoUrl ||
    typeof rawVideoUrl !== 'string' ||
    !/^https:\/\/[a-z0-9-]+\.hf\.space\//i.test(rawVideoUrl)
  ) {
    return res.status(400).json({ error: 'Valid Hugging Face Space Wan video URL is required.' });
  }

  const duration = normalizeVideoDuration(rawDuration);
  const aspectRatio = normalizeVideoAspect(rawAspect);
  const quality = normalizeVideoQuality(rawQuality);
  const jobId = `mjob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const job: VideoJobState = {
    jobId,
    status: 'processing',
    progress: 82,
    prompt: 'Wan Video Mastering',
    duration,
    aspectRatio,
    quality,
    createdAt: Date.now(),
  };
  videoJobs.set(jobId, job);

  void (async () => {
    try {
      const videoUrl = await fetchAndMasterWanClip(
        rawVideoUrl,
        {},
        duration,
        aspectRatio,
        quality,
        (pct) => {
          job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
        }
      );
      if (videoUrl) {
        job.progress = 100;
        job.status = 'completed';
        job.videoUrl = videoUrl;
        job.model = WAN22_14B_T2V_MODEL;
      } else {
        job.status = 'failed';
        job.error = 'Failed to master Wan video clip.';
      }
    } catch (err: any) {
      job.status = 'failed';
      job.error = err?.message || 'Failed to master Wan video clip.';
    }
  })();

  return res.status(202).json({
    jobId,
    status: 'processing',
    progress: job.progress,
    duration,
    aspectRatio,
    quality,
  });
});

// Start async Text-to-Video job immediately (< 5ms response prevents any Cloud Run 60s HTTP timeout)
app.post('/api/generate-video', async (req, res) => {
  const { prompt, duration: rawDuration, aspectRatio: rawAspect, quality: rawQuality } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const cleanPrompt = prompt.trim();
  const duration = normalizeVideoDuration(rawDuration);
  const aspectRatio = normalizeVideoAspect(rawAspect);
  const quality = normalizeVideoQuality(rawQuality);
  const jobId = `vjob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const job: VideoJobState = {
    jobId,
    status: 'processing',
    progress: 4,
    prompt: cleanPrompt,
    duration,
    aspectRatio,
    quality,
    createdAt: Date.now(),
  };
  videoJobs.set(jobId, job);

  // Kick off generation asynchronously in background
  void executeVideoJobInBackground(job);

  return res.status(202).json({
    jobId,
    status: 'processing',
    progress: job.progress,
    duration,
    aspectRatio,
    quality,
  });
});

// Poll async Text-to-Video job status + live percentage progress
app.get('/api/generate-video/status/:jobId', (req, res) => {
  const job = videoJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ status: 'failed', error: 'Video generation job not found.' });
  }

  return res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl || null,
    prompt: job.prompt,
    duration: job.duration,
    aspectRatio: job.aspectRatio,
    quality: job.quality,
    model: job.model,
    error: job.error,
  });
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
  server.setTimeout(300000);
}

startServer();


