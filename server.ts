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

// Xkiro API Configuration (Primary Chat & Photo Prompt Compiler when XKIRO_API_KEY is set)
const XKIRO_API_KEY = (process.env.XKIRO_API_KEY || '').trim();
const XKIRO_CHAT_URL = 'https://api.xkiro.com/v1/chat/completions';
const XKIRO_MODELS_URL = 'https://api.xkiro.com/v1/models';
const XKIRO_VISION_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
  'mistralai/ministral-8b',
  'mistralai/mistral-large-2512',
  'mistralai/mistral-medium-3.5',
  'mistralai/mistral-small-2603',
  'cohere/command-a-plus',
  'cohere/command-a-vision',
  'mistralai/ministral-14b',
];
const XKIRO_TEXT_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
  'mistralai/ministral-8b',
  'mistralai/mistral-large-2512',
  'mistralai/mistral-medium-3.5',
  'mistralai/mistral-small-2603',
  'cohere/command-a-plus',
  'cohere/command-a',
  'mistralai/ministral-14b',
];
const XKIRO_PHOTO_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
  'mistralai/ministral-8b',
  'mistralai/mistral-small-2603',
  'mistralai/mistral-large-2512',
];

const xkiroUnavailableCache = new Map<string, number>();
let xkiroCatalogCache: { freeModels: Set<string>; dynamicQwen: string[]; fetchedAt: number } = {
  freeModels: new Set(),
  dynamicQwen: [],
  fetchedAt: 0,
};

function markXkiroModelCooldown(model: string, status: number): void {
  const now = Date.now();
  if (status === 403 || status === 404) {
    xkiroUnavailableCache.set(model, now + 10 * 60 * 1000);
  } else if (status === 429 || status === 502 || status === 503 || status === 504) {
    xkiroUnavailableCache.set(model, now + 90 * 1000);
  }
}

function isXkiroModelInCooldown(model: string, now: number = Date.now()): boolean {
  const blockedUntil = xkiroUnavailableCache.get(model);
  if (!blockedUntil) return false;
  if (now < blockedUntil) return true;
  xkiroUnavailableCache.delete(model);
  return false;
}

async function getPrioritizedXkiroModels(hasImages: boolean): Promise<string[]> {
  const now = Date.now();
  if (now - xkiroCatalogCache.fetchedAt > 10 * 60 * 1000) {
    try {
      const res = await fetch(XKIRO_MODELS_URL, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const json: any = await res.json();
        const catalog: any[] = Array.isArray(json?.data) ? json.data : [];
        const freeEntries = catalog.filter(
          (m) => typeof m?.id === 'string' && m?.access_tier === 'free'
        );
        const freeModels = new Set(freeEntries.map((m) => m.id as string));
        const dynamicQwen = freeEntries
          .filter((m) => /qwen/i.test(m.id) && (!hasImages || m?.capabilities?.vision))
          .map((m) => m.id as string);
        xkiroCatalogCache = { freeModels, dynamicQwen, fetchedAt: now };
      } else {
        xkiroCatalogCache.fetchedAt = now - 8 * 60 * 1000;
      }
    } catch {
      xkiroCatalogCache.fetchedAt = now - 8 * 60 * 1000;
    }
  }

  const baseList = hasImages ? XKIRO_VISION_MODELS : XKIRO_TEXT_MODELS;
  const combined = [...xkiroCatalogCache.dynamicQwen, ...baseList];
  const deduped: string[] = [];
  const hasCatalog = xkiroCatalogCache.freeModels.size > 0;
  for (const id of combined) {
    if (deduped.includes(id)) continue;
    if (hasCatalog && !xkiroCatalogCache.freeModels.has(id)) continue;
    if (isXkiroModelInCooldown(id, now)) continue;
    deduped.push(id);
  }
  return deduped.length > 0 ? deduped : baseList;
}

// Hugging Face API Configuration (Fallback / Video & Image Tiers)
const HF_ACCESS_TOKEN = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '';
const HF_CHAT_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_CHAT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'deepseek-ai/DeepSeek-R1',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'meta-llama/Llama-3.1-8B-Instruct',
];
const HF_DEFAULT_CHAT_MODEL = HF_CHAT_MODELS[0];

// Shared helper: Transcribe base64 voice audio using Gemini with safe fallback
async function transcribeAudioWithGemini(audioData: string, mimeType?: string): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return '';
  }

  try {
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

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          audioPart,
          { text: 'Transcribe this audio speech accurately into plain text without any conversational preamble or markdown quotes.' },
        ],
      },
    });

    return response.text?.trim() || '';
  } catch (err: any) {
    console.warn('Transcription warning:', err?.message || err);
    return '';
  }
}

// Transcribe voice recording endpoint with safe fallback
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
    return res.json({ text: '' });
  }
});

// Comprehensive API Health and Diagnostics Check
app.get('/api/health', async (_req, res) => {
  return res.json({
    status: 'ok',
    name: 'BloopX API Service',
    time: new Date().toISOString(),
    provider: XKIRO_API_KEY ? 'Xkiro + Multi-Tier Failover' : 'Multi-Tier Failover',
    hasXkiroKey: !!XKIRO_API_KEY,
    hasHfToken: !!HF_ACCESS_TOKEN,
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    endpoints: {
      chat: {
        status: 'healthy',
        primary: XKIRO_API_KEY ? 'Xkiro Router' : 'Free Failover Cluster',
        models: XKIRO_TEXT_MODELS,
      },
      photo: {
        status: 'healthy',
        providers: ['Xkiro SenseNova', 'FLUX.1-schnell', 'Z-Image-Turbo', 'AI Horde SDXL'],
      },
      video: {
        status: 'healthy',
        providers: ['Wan 2.2 14B', 'Wan 2.2 5B', 'Wan 2.1 14B', 'Alibaba PAI DiT'],
      },
      database: {
        status: 'connected',
        id: 'ai-studio-gutiaiplayground-aeb9da6e-3033-483f-a2ca-272cdb80d02c',
      },
    },
  });
});

function extractTextFromChoiceContent(rawContent: any): string {
  if (typeof rawContent === 'string') return rawContent.trim();
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

// Primary Xkiro Chat Completion caller (uses verified live free Flash/vision models)
async function callXkiroChat(
  payloadMessages: any[],
  hasImages: boolean
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  if (!XKIRO_API_KEY) return null;

  const modelsToTry = await getPrioritizedXkiroModels(hasImages);
  for (const model of modelsToTry) {
    try {
      const res = await fetch(XKIRO_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${XKIRO_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: payloadMessages,
          max_tokens: 900,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        if (res.status === 401) {
          return null;
        }
        markXkiroModelCooldown(model, res.status);
        continue;
      }

      const data: any = await res.json();
      const trimmed = extractTextFromChoiceContent(data?.choices?.[0]?.message?.content);
      if (trimmed.length > 0) {
        const apiTotalTokens =
          typeof data.usage?.total_tokens === 'number' && data.usage.total_tokens > 0
            ? data.usage.total_tokens
            : 0;
        const estimatedInputChars = JSON.stringify(payloadMessages).length;
        const fallbackTokens = Math.max(60, Math.ceil((estimatedInputChars + trimmed.length) / 4));
        return {
          content: trimmed,
          tokensUsed: apiTotalTokens || fallbackTokens,
          modelUsed: model,
        };
      }
    } catch {
      markXkiroModelCooldown(model, 504);
    }
  }

  return null;
}

// Secondary Hugging Face Chat completion caller (when HF_TOKEN is configured)
async function callHuggingFaceChat(
  payloadMessages: any[],
  clientToken?: string
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const token = clientToken || HF_ACCESS_TOKEN;
  if (!token) return null;

  for (const model of HF_CHAT_MODELS) {
    try {
      const res = await fetch(HF_CHAT_ROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages: payloadMessages,
          max_tokens: 800,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        console.warn(`Hugging Face model ${model} HTTP ${res.status}: ${errorText.slice(0, 120)}`);
        if (res.status === 401 || res.status === 403) return null;
        continue;
      }

      const data: any = await res.json();
      const trimmed = extractTextFromChoiceContent(data?.choices?.[0]?.message?.content);
      if (trimmed.length > 0) {
        const apiTotalTokens =
          typeof data.usage?.total_tokens === 'number' && data.usage.total_tokens > 0
            ? data.usage.total_tokens
            : 0;
        const estimatedInputChars = JSON.stringify(payloadMessages).length;
        const fallbackTokens = Math.max(60, Math.ceil((estimatedInputChars + trimmed.length) / 4));
        return {
          content: trimmed,
          tokensUsed: apiTotalTokens || fallbackTokens,
          modelUsed: model,
        };
      }
    } catch (err: any) {
      console.warn(`Error on Hugging Face model ${model}:`, err?.message || err);
    }
  }

  return null;
}

// Tertiary Gemini Chat fallback (when GEMINI_API_KEY is configured)
async function callGeminiFallbackChat(
  recentMessages: Array<{ role: string; content: string }>,
  attachments: any[]
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const parts: any[] = [];
    const transcriptLines = recentMessages.map(
      (m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`
    );
    parts.push({
      text: `You are BloopX AI. Be concise, direct, helpful, and clear.\n\n${transcriptLines.join('\n')}\nAssistant:`,
    });
    for (const att of attachments) {
      if (att?.data && typeof att?.mimeType === 'string' && att.mimeType.startsWith('image/')) {
        parts.push({ inlineData: { mimeType: att.mimeType, data: String(att.data) } });
      }
    }
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts },
    });
    const text = resp.text?.trim() || '';
    if (text) {
      return {
        content: text,
        tokensUsed: Math.max(60, Math.ceil((JSON.stringify(recentMessages).length + text.length) / 4)),
        modelUsed: 'gemini-2.5-flash',
      };
    }
  } catch (err: any) {
    console.warn('Gemini chat fallback warning:', err?.message || err);
  }
  return null;
}

// Zero-key preview fallback using Pollinations & AI Horde text workers
async function callZeroKeyFallbackChat(
  plainMessages: Array<{ role: string; content: string }>
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  // 1. Pollinations OpenAI-compatible text endpoint
  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: plainMessages,
        max_tokens: 750,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const trimmed = extractTextFromChoiceContent(data?.choices?.[0]?.message?.content);
      if (trimmed.length > 0) {
        const tokens =
          typeof data.usage?.total_tokens === 'number' && data.usage.total_tokens > 0
            ? data.usage.total_tokens
            : Math.max(60, Math.ceil((JSON.stringify(plainMessages).length + trimmed.length) / 4));
        return {
          content: trimmed,
          tokensUsed: tokens,
          modelUsed: data?.model || 'pollinations-openai',
        };
      }
    }
  } catch (err: any) {
    console.warn('Pollinations text fallback warning:', err?.message || err);
  }

  // 2. AI Horde distributed text generation fallback
  try {
    const promptLines = plainMessages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
    const hordePrompt =
      'System: You are BloopX AI. Reply concisely, directly, and helpfully.\n' +
      promptLines.join('\n') +
      '\nAssistant:';

    const submitRes = await fetch('https://stablehorde.net/api/v2/generate/text/async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: '0000000000' },
      body: JSON.stringify({
        prompt: hordePrompt,
        params: { max_length: 260, temperature: 0.7, stop_sequence: ['\nUser:', 'User:'] },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (submitRes.ok) {
      const submitJson: any = await submitRes.json();
      const jobId = submitJson?.id;
      if (jobId) {
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const statusRes = await fetch(`https://stablehorde.net/api/v2/generate/text/status/${jobId}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!statusRes.ok) continue;
          const statusJson: any = await statusRes.json();
          if (statusJson?.done) {
            const rawText = String(statusJson?.generations?.[0]?.text || '')
              .replace(/\nUser:[\s\S]*$/i, '')
              .trim();
            if (rawText.length > 0) {
              return {
                content: rawText,
                tokensUsed: Math.max(60, Math.ceil((hordePrompt.length + rawText.length) / 4)),
                modelUsed: statusJson?.generations?.[0]?.model || 'ai-horde-text',
              };
            }
            break;
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('AI Horde text fallback warning:', err?.message || err);
  }

  return null;
}

// Chat completion endpoint - Xkiro Primary with Multi-Tier Failover
app.post('/api/chat', async (req, res) => {
  const { messages, attachments } = req.body;
  const clientHfToken = (req.headers['x-hf-token'] as string) || '';

  if (!messages || !Array.isArray(messages) || messages.length > 60) {
    return res.status(400).json({ error: 'Valid messages array is required' });
  }

  const safeAttachments = Array.isArray(attachments)
    ? attachments
        .filter(
          (att: any) =>
            att &&
            typeof att.data === 'string' &&
            typeof att.mimeType === 'string' &&
            att.data.length < 30_000_000
        )
        .slice(0, 12)
    : [];

  const hasMedia = safeAttachments.length > 0;
  const hasImages = safeAttachments.some((att: any) => att.mimeType.startsWith('image/'));
  let voiceTranscript = '';

  // Transcribe any sent voice audio attachment so the AI responds directly to the spoken voice message
  if (hasMedia) {
    const audioAtt = safeAttachments.find((att: any) => att.mimeType.startsWith('audio/'));
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
      const role = m?.role === 'assistant' ? 'assistant' : 'user';
      return { role, content: textContent };
    })
    .filter((m: any) => m.content.length > 0);

  const recentMessages =
    normalizedMessages.length > 0
      ? normalizedMessages.slice(-8)
      : [
          {
            role: 'user',
            content:
              voiceTranscript ||
              'The user sent a voice audio clip. Politely let them know if audio transcription is unavailable and invite them to type or try again.',
          },
        ];

  const systemPrompt = {
    role: 'system',
    content:
      'You are BloopX AI. Be concise, direct, helpful, and clear. Avoid verbose pleasantries or excessive repetition.',
  };

  const openAiMessages = [
    systemPrompt,
    ...recentMessages.map((m: any, idx: number) => {
      if (idx === recentMessages.length - 1 && hasImages) {
        const parts: any[] = [];
        if (m.content) {
          parts.push({ type: 'text', text: m.content });
        }
        for (const att of safeAttachments) {
          if (att.mimeType.startsWith('image/')) {
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

  const plainMessages = [systemPrompt, ...recentMessages];

  try {
    // Tier 1: Xkiro API
    const xkiroResult = await callXkiroChat(openAiMessages, hasImages);
    if (xkiroResult) {
      return res.json({
        content: xkiroResult.content,
        voiceTranscript: voiceTranscript || undefined,
        tokensUsed: xkiroResult.tokensUsed,
        provider: `Xkiro (${xkiroResult.modelUsed})`,
      });
    }

    // Tier 2: Hugging Face Router (if HF_TOKEN is configured)
    const hfResult = await callHuggingFaceChat(openAiMessages, clientHfToken);
    if (hfResult) {
      return res.json({
        content: hfResult.content,
        voiceTranscript: voiceTranscript || undefined,
        tokensUsed: hfResult.tokensUsed,
        provider: `HuggingFace (${hfResult.modelUsed})`,
      });
    }

    // Tier 3: Gemini Fallback (if GEMINI_API_KEY is configured)
    const geminiResult = await callGeminiFallbackChat(recentMessages, safeAttachments);
    if (geminiResult) {
      return res.json({
        content: geminiResult.content,
        voiceTranscript: voiceTranscript || undefined,
        tokensUsed: geminiResult.tokensUsed,
        provider: `Gemini (${geminiResult.modelUsed})`,
      });
    }

    // Tier 4: Zero-key failover (Pollinations -> AI Horde)
    const zeroKeyResult = await callZeroKeyFallbackChat(plainMessages);
    if (zeroKeyResult) {
      return res.json({
        content: zeroKeyResult.content,
        voiceTranscript: voiceTranscript || undefined,
        tokensUsed: zeroKeyResult.tokensUsed,
        provider: zeroKeyResult.modelUsed,
      });
    }

    const hint = !XKIRO_API_KEY
      ? 'Please configure XKIRO_API_KEY in Settings -> Secrets to enable Xkiro chat, or retry in a few moments.'
      : 'AI chat servers are temporarily busy. Please try again in a moment.';
    return res.status(503).json({ error: hint });
  } catch (err: any) {
    console.error('Chat endpoint error:', err?.message || err);
    return res.status(500).json({
      error: `AI response failed: ${err?.message || 'Error communicating with AI chat service'}`,
    });
  }
});

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

function cleanCompiledCameraPrompt(rawText: string): string | null {
  let cleaned = rawText
    .replace(/^.*?(?:Prompt:|Output:)\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\b(?:cartoon(?:ish)?|anime|3d\s*render|cgi|illustration|painting|masterpiece)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (cleaned.length > 12 && cleaned.length < 550) {
    if (!/^unedited\s+raw/i.test(cleaned) && !/^raw\s+(?:candid|35mm|dslr)/i.test(cleaned)) {
      cleaned = `Unedited RAW 35mm DSLR photograph of ${cleaned}`;
    }
    return cleaned;
  }
  return null;
}

// Strict Prompt Rule & True Camera Realism Compiler (Xkiro SenseNova -> Hugging Face -> Local Deterministic)
async function compileStrictRealisticPrompt(
  rawPrompt: string,
  clientToken?: string
): Promise<{ compiledPrompt: string; directImageUri?: string }> {
  const compilerSystem =
    'You are a strict camera-realism prompt compiler. Convert the user request into ONE concise English description (35-60 words) for an authentic real-world DSLR photograph starting with: Unedited RAW 35mm DSLR photograph of';

  // 1. Primary: Xkiro SenseNova prompt compiler
  if (XKIRO_API_KEY) {
    const deadline = Date.now() + 4500;
    const now = Date.now();
    const activePhotoModels = XKIRO_PHOTO_MODELS.filter((m) => !isXkiroModelInCooldown(m, now));
    const modelsToTry = activePhotoModels.length > 0 ? activePhotoModels : XKIRO_PHOTO_MODELS;
    for (const model of modelsToTry) {
      const remaining = deadline - Date.now();
      if (remaining < 700) break;
      try {
        const xRes = await fetch(XKIRO_CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${XKIRO_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 150,
            temperature: 0.15,
            reasoning_effort: 'none',
            messages: [
              { role: 'system', content: compilerSystem },
              { role: 'user', content: rawPrompt },
            ],
          }),
          signal: AbortSignal.timeout(Math.min(3500, remaining)),
        });
        if (!xRes.ok) {
          if (xRes.status === 401) break;
          markXkiroModelCooldown(model, xRes.status);
          continue;
        }
        const xData: any = await xRes.json();
        const content = extractTextFromChoiceContent(xData?.choices?.[0]?.message?.content);
        const compiled = cleanCompiledCameraPrompt(content);
        if (compiled) return { compiledPrompt: compiled };
      } catch {
        markXkiroModelCooldown(model, 504);
      }
    }
  }

  // 2. Secondary: Hugging Face Router prompt compiler (if HF_TOKEN configured)
  try {
    const token = clientToken || HF_ACCESS_TOKEN;
    if (token) {
      const hfRes = await fetch(HF_CHAT_ROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: HF_DEFAULT_CHAT_MODEL,
          max_tokens: 115,
          temperature: 0.1,
          messages: [
            { role: 'system', content: compilerSystem },
            { role: 'user', content: rawPrompt },
          ],
        }),
        signal: AbortSignal.timeout(3000),
      });

      if (hfRes.ok) {
        const hfData: any = await hfRes.json();
        const content = extractTextFromChoiceContent(hfData?.choices?.[0]?.message?.content);
        const compiled = cleanCompiledCameraPrompt(content);
        if (compiled) return { compiledPrompt: compiled };
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

// Gradio FLUX / Z-Image Space photo generator
async function generateGradioFluxPhotoBuffer(
  spaceBaseUrl: string,
  dataPayload: any[],
  timeoutMs: number = 12000,
  endpointPath: string = '/infer',
  clientToken?: string
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const activeHeaders: Record<string, string> = clientToken
    ? { Authorization: `Bearer ${clientToken}` }
    : {};

  try {
    const postRes = await fetch(`${spaceBaseUrl}/gradio_api/call${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...activeHeaders },
      body: JSON.stringify({ data: dataPayload }),
      signal: controller.signal,
    });
    if (!postRes.ok) return null;

    const postData: any = await postRes.json();
    const eventId = postData?.event_id;
    if (!eventId) return null;

    const sseRes = await fetch(`${spaceBaseUrl}/gradio_api/call${endpointPath}/${eventId}`, {
      headers: activeHeaders,
      signal: controller.signal,
    });
    if (!sseRes.ok) return null;

    const streamText = await sseRes.text();
    if (streamText.includes('event: error')) return null;

    const match = streamText.match(/"url":\s*"([^"]+)"/);
    if (!match || !match[1] || match[1].includes('Error:')) return null;

    const imgFetch = await fetch(match[1], { headers: activeHeaders, signal: controller.signal });
    if (!imgFetch.ok) return null;

    const buffer = Buffer.from(await imgFetch.arrayBuffer());
    return buffer.length >= 5000 ? buffer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Native Hugging Face Inference Providers Router API (fal-ai FLUX.1-schnell, Qwen-Image, fast-sdxl when HF_TOKEN is set)
async function generateHuggingFaceInferencePhoto(
  promptText: string,
  width: number,
  height: number,
  clientToken?: string
): Promise<Buffer | null> {
  const token = clientToken || HF_ACCESS_TOKEN;
  if (!token) return null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const endpoints = [
    {
      name: 'fal-flux-schnell',
      url: 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell',
      body: {
        prompt: promptText,
        image_size: { width: Math.min(width, 1024), height: Math.min(height, 1024) },
        num_inference_steps: 4,
      },
    },
    {
      name: 'fal-qwen-image',
      url: 'https://router.huggingface.co/fal-ai/fal-ai/qwen-image',
      body: {
        prompt: promptText,
        image_size: { width: Math.min(width, 1024), height: Math.min(height, 1024) },
      },
    },
    {
      name: 'fal-fast-sdxl',
      url: 'https://router.huggingface.co/fal-ai/fal-ai/fast-sdxl',
      body: {
        prompt: promptText,
        image_size: { width: Math.min(width, 1024), height: Math.min(height, 1024) },
      },
    },
  ];

  try {
    return await Promise.any(
      endpoints.map(async (ep) => {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) {
          throw new Error(`${ep.name}_${res.status}`);
        }
        const cType = res.headers.get('content-type') || '';
        if (cType.startsWith('image/') || cType.includes('octet-stream')) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 5000) return buf;
          throw new Error(`${ep.name}_small`);
        }
        const json: any = await res.json();
        const imgUrl = json?.images?.[0]?.url || json?.data?.[0]?.url || json?.image?.url || json?.url;
        const b64 = json?.images?.[0]?.b64_json || json?.data?.[0]?.b64_json;
        if (typeof b64 === 'string' && b64.length > 5000) {
          return Buffer.from(b64, 'base64');
        }
        if (typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (buf.length > 5000) return buf;
          }
        }
        throw new Error(`${ep.name}_no_img`);
      })
    );
  } catch {
    return null;
  }
}

// Distributed AI Horde SDXL/Photorealistic fallback (zero IP rate-limit, kudos-safe settings)
async function generateAiHordePhotoBuffer(
  fullPrompt: string,
  aspectRatio: PhotoAspectOption
): Promise<Buffer | null> {
  // Keep pixel area <= 512*512 (262,144 px) so anonymous Horde requests never exceed the free kudos tier
  const [hordeW, hordeH] =
    aspectRatio === '16:9'
      ? [640, 384]
      : aspectRatio === '9:16'
      ? [384, 640]
      : aspectRatio === '4:3'
      ? [576, 448]
      : aspectRatio === '3:4'
      ? [448, 576]
      : [512, 512];

  // Dynamically pick online photorealistic SD1.5 models from AI Horde (avoids SDXL 403 KudosUpfront)
  let hordeModels = [
    'Deliberate',
    'Realistic Vision',
    "ICBINP - I Can't Believe It's Not Photography",
    'Edge Of Realism',
    'majicMIX realistic',
    'stable_diffusion',
  ];
  try {
    const modelsRes = await fetch('https://stablehorde.net/api/v2/status/models?type=image', {
      signal: AbortSignal.timeout(2500),
    });
    if (modelsRes.ok) {
      const list: any[] = await modelsRes.json();
      const fastReal = list
        .filter(
          (m) =>
            m?.count > 0 &&
            typeof m?.name === 'string' &&
            !/inpaint|xl|pony|flux/i.test(m.name) &&
            /edge of realism|majicmix|realistic vision|icbinp|deliberate|ether real|epic diffusion|dreamshaper|stable_diffusion/i.test(
              m.name
            ) &&
            Number(m?.eta ?? 999) <= 35
        )
        .sort((a, b) => Number(a.eta) - Number(b.eta) || Number(b.count) - Number(a.count))
        .slice(0, 6)
        .map((m) => m.name as string);
      if (fastReal.length > 0) {
        if (!fastReal.includes('stable_diffusion')) {
          fastReal.push('stable_diffusion');
        }
        hordeModels = fastReal;
      }
    }
  } catch {
    // Use curated low-ETA list
  }

  const submitJob = (w: number, h: number, steps: number, models: string[]) =>
    fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: '0000000000',
        'Client-Agent': 'BloopX:1.0:server',
      },
      body: JSON.stringify({
        prompt: `${fullPrompt} ### cartoon, anime, illustration, cgi, 3d render, watermark, text, blurry, deformed`,
        params: {
          width: w,
          height: h,
          steps,
          n: 1,
          cfg_scale: 7,
          sampler_name: 'k_euler',
        },
        models,
        nsfw: false,
        censor_nsfw: true,
        r2: true,
      }),
      signal: AbortSignal.timeout(6000),
    });

  try {
    let submitRes = await submitJob(hordeW, hordeH, 16, hordeModels);
    if (submitRes.status === 403) {
      submitRes = await submitJob(512, 512, 12, ['Deliberate', 'Realistic Vision', 'stable_diffusion']);
    }

    if (!submitRes.ok) return null;
    const submitJson: any = await submitRes.json();
    const jobId = submitJson?.id;
    if (!jobId) return null;

    for (let poll = 0; poll < 38; poll++) {
      await new Promise((r) => setTimeout(r, 1300));
      try {
        const checkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!checkRes.ok) continue;
        const checkJson: any = await checkRes.json();
        if (checkJson?.faulted) return null;
        if (checkJson?.done) {
          const statusRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${jobId}`, {
            signal: AbortSignal.timeout(8000),
          });
          if (!statusRes.ok) return null;
          const statusJson: any = await statusRes.json();
          const imgRef = statusJson?.generations?.[0]?.img;
          if (!imgRef || typeof imgRef !== 'string') return null;

          if (imgRef.startsWith('http://') || imgRef.startsWith('https://')) {
            const imgRes = await fetch(imgRef, { signal: AbortSignal.timeout(10000) });
            if (!imgRes.ok) return null;
            const buf = Buffer.from(await imgRes.arrayBuffer());
            return buf.length > 5000 ? buf : null;
          }
          // Base64 WebP fallback
          const rawB64 = imgRef.includes(',') ? imgRef.split(',')[1] : imgRef;
          const buf = Buffer.from(rawB64, 'base64');
          return buf.length > 5000 ? buf : null;
        }
      } catch {
        // Ignore transient poll hiccup
      }
    }
  } catch (err: any) {
    console.warn('AI Horde photo fallback warning:', err?.message || err);
  }
  return null;
}

// Unified multi-tier realistic photo generator honoring user-selected aspectRatio & quality
async function generateReliablePhoto(
  compiledScenePrompt: string,
  aspectRatio: PhotoAspectOption,
  quality: PhotoQualityOption,
  clientToken?: string
): Promise<{ buffer: Buffer; mimeType: string; provider: string } | null> {
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

  // 1. Race Hugging Face Inference API + FLUX.1-schnell Space so whichever responds first wins cleanly
  try {
    const firstFastFlux = await Promise.any([
      generateHuggingFaceInferencePhoto(fullPrompt, fluxWidth, fluxHeight, clientToken).then((buf) => {
        if (!buf) throw new Error('hf-inference-empty');
        return { buf, mime: 'image/jpeg' as const, provider: XKIRO_API_KEY ? 'Xkiro-SenseNova-FLUX' : 'HuggingFace-FLUX.1-schnell' };
      }),
      generateGradioFluxPhotoBuffer(
        'https://black-forest-labs-flux-1-schnell.hf.space',
        [fullPrompt, seed, true, fluxWidth, fluxHeight, fluxSteps],
        12000,
        '/infer',
        clientToken
      ).then((buf) => {
        if (!buf) throw new Error('flux-space-empty');
        return { buf, mime: 'image/webp' as const, provider: XKIRO_API_KEY ? 'Xkiro-SenseNova-FLUX' : 'FLUX.1-schnell' };
      }),
    ]);
    const out = await enhanceAndFormatPhoto(firstFastFlux.buf, firstFastFlux.mime, width, height, jpegQ);
    return { ...out, provider: firstFastFlux.provider };
  } catch {
    // Continue to Tier 2 parallel failover if both Tier 1 renderers fail
  }

  // 2. Race Z-Image-Turbo Space + Distributed AI Horde SDXL/Photorealistic cluster
  try {
    const fallbackRender = await Promise.any([
      generateGradioFluxPhotoBuffer(
        'https://tongyi-mai-z-image-turbo.hf.space',
        [fullPrompt, fluxWidth, fluxHeight, 9, seed, true],
        6000,
        '/generate',
        clientToken
      ).then((buf) => {
        if (!buf) throw new Error('zimage-empty');
        return { buf, mime: 'image/webp' as const, provider: XKIRO_API_KEY ? 'Xkiro-SenseNova-ZImage' : 'Z-Image-Turbo' };
      }),
      generateAiHordePhotoBuffer(`${compiledScenePrompt}, ${framingHint}`, aspectRatio).then((buf) => {
        if (!buf) throw new Error('horde-empty');
        return { buf, mime: 'image/webp' as const, provider: XKIRO_API_KEY ? 'Xkiro-SenseNova-SDXL' : 'SDXL-Photo' };
      }),
    ]);
    const out = await enhanceAndFormatPhoto(fallbackRender.buf, fallbackRender.mime, width, height, jpegQ);
    return { ...out, provider: fallbackRender.provider };
  } catch {
    return null;
  }
}

interface PhotoFilterPlan {
  mode: 'filter';
  grayscale?: boolean;
  sepia?: boolean;
  invert?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  warmth?: number;
  blur?: number;
  sharpen?: number;
  vignette?: boolean;
  vintage?: boolean;
  cropAspect?: PhotoAspectOption | null;
}

interface PhotoImg2ImgPlan {
  mode: 'img2img';
  editedPrompt: string;
  strength: number;
  targetAspect?: PhotoAspectOption | null;
}

type PhotoEditPlan = PhotoFilterPlan | PhotoImg2ImgPlan;

function pickClosestPhotoAspect(w: number, h: number): PhotoAspectOption {
  if (!w || !h) return '1:1';
  const ratio = w / h;
  const candidates: Array<{ aspect: PhotoAspectOption; r: number }> = [
    { aspect: '1:1', r: 1 },
    { aspect: '16:9', r: 16 / 9 },
    { aspect: '9:16', r: 9 / 16 },
    { aspect: '4:3', r: 4 / 3 },
    { aspect: '3:4', r: 3 / 4 },
  ];
  let best = candidates[0];
  let bestDiff = Math.abs(ratio - best.r);
  for (const c of candidates.slice(1)) {
    const diff = Math.abs(ratio - c.r);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.aspect;
}

function probeImageDimensions(imageBuffer: Buffer): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        'pipe:0',
      ]);
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
        resolve(null);
      }, 3000);
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || chunks.length === 0) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const st = parsed?.streams?.[0];
          const w = Number(st?.width);
          const h = Number(st?.height);
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            resolve({ width: w, height: h });
            return;
          }
        } catch {}
        resolve(null);
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(imageBuffer);
    } catch {
      resolve(null);
    }
  });
}

function prepareNormalizedSourceBuffer(
  imageBuffer: Buffer,
  targetW: number,
  targetH: number,
  format: 'jpeg' | 'png' = 'jpeg'
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const vf = `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${targetW}:${targetH},format=rgb24`;
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vf',
        vf,
        ...(format === 'jpeg' ? ['-q:v', '2', '-vcodec', 'mjpeg'] : ['-vcodec', 'png']),
        '-f',
        'image2pipe',
        'pipe:1',
      ];
      const ff = spawn('ffmpeg', args);
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try {
          ff.kill('SIGKILL');
        } catch {}
        resolve(null);
      }, 6000);
      ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      ff.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      ff.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && chunks.length > 0) {
          const out = Buffer.concat(chunks);
          if (out.length > 1000) {
            resolve(out);
            return;
          }
        }
        resolve(null);
      });
      ff.stdin.on('error', () => {});
      ff.stdin.end(imageBuffer);
    } catch {
      resolve(null);
    }
  });
}

function applyFfmpegPhotoFilters(
  sourceBuffer: Buffer,
  plan: PhotoFilterPlan,
  targetW: number,
  targetH: number,
  jpegQ: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  return new Promise((resolve) => {
    try {
      const filters: string[] = [];

      if (plan.rotate === 90) filters.push('transpose=1');
      else if (plan.rotate === 180) filters.push('transpose=1,transpose=1');
      else if (plan.rotate === 270) filters.push('transpose=2');

      if (plan.flipH) filters.push('hflip');
      if (plan.flipV) filters.push('vflip');

      // Scale/crop cleanly to final aspect & resolution after orientation changes
      filters.push(`scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:flags=lanczos`);
      filters.push(`crop=${targetW}:${targetH}`);

      const brightness = Math.max(-0.45, Math.min(0.45, Number(plan.brightness) || 0));
      const contrast = Math.max(0.4, Math.min(2.0, Number(plan.contrast) || 1));
      const saturation = plan.grayscale
        ? 0
        : Math.max(0, Math.min(2.4, Number(plan.saturation ?? 1)));

      if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
        filters.push(
          `eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`
        );
      }

      if (plan.grayscale) {
        filters.push('hue=s=0');
      }

      if (plan.sepia || plan.vintage) {
        filters.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
        if (plan.vintage) {
          filters.push('eq=contrast=1.08:brightness=0.02:saturation=0.85');
        }
      }

      const warmth = Math.max(-0.35, Math.min(0.35, Number(plan.warmth) || 0));
      if (warmth !== 0) {
        const rs = warmth.toFixed(3);
        const bs = (-warmth).toFixed(3);
        filters.push(`colorbalance=rs=${rs}:gs=${(warmth * 0.15).toFixed(3)}:bs=${bs}:rm=${rs}:bm=${bs}`);
      }

      if (plan.invert) {
        filters.push('negate');
      }

      const blurAmt = Math.max(0, Math.min(18, Number(plan.blur) || 0));
      if (blurAmt > 0.2) {
        filters.push(`gblur=sigma=${blurAmt.toFixed(2)}`);
      }

      const sharpAmt = Math.max(0.15, Math.min(2.5, Number(plan.sharpen) || 0.28));
      filters.push(`unsharp=5:5:${sharpAmt.toFixed(2)}:5:5:0.0`);

      if (plan.vignette || plan.vintage) {
        filters.push('vignette=PI/4');
      }

      const ff = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vf',
        filters.join(','),
        '-q:v',
        jpegQ,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ]);

      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try {
          ff.kill('SIGKILL');
        } catch {}
        resolve(null);
      }, 8000);

      ff.stdout.on('data', (c: Buffer) => chunks.push(c));
      ff.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      ff.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && chunks.length > 0) {
          const out = Buffer.concat(chunks);
          if (out.length > 1500) {
            resolve({ buffer: out, mimeType: 'image/jpeg' });
            return;
          }
        }
        resolve(null);
      });
      ff.stdin.on('error', () => {});
      ff.stdin.end(sourceBuffer);
    } catch {
      resolve(null);
    }
  });
}

function buildFallbackPhotoEditPlan(editInstruction: string): PhotoEditPlan {
  const lower = editInstruction.toLowerCase();
  const hasGenerativeTerms =
    /\b(?:add|remove|delete|erase|replace|put|wear|wearing|dress|shirt|jacket|suit|hat|glasses|sunglasses|hair|background|sky|beach|city|forest|night|sunset|snow|rain|fire|smile|laugh|cry|dog|cat|car|person|people|man|woman|boy|girl|cartoon|anime|painting|sketch|watercolor|oil|cyberpunk|3d|pixel|tattoo|beard|mustache|makeup)\b/i.test(
      lower
    );

  if (!hasGenerativeTerms) {
    const isBw = /\b(?:black\s*(?:&|and)?\s*white|b&w|bw|grayscale|greyscale|monochrome)\b/i.test(lower);
    const isSepia = /\bsepia\b/i.test(lower);
    const isVintage = /\b(?:vintage|retro|film\s*filter|old\s*photo)\b/i.test(lower);
    const isInvert = /\b(?:invert|negative\s*colors?)\b/i.test(lower);
    const isFlipH = /\b(?:flip\s*horizontal|mirror|flip\s*left|flip\s*right)\b/i.test(lower);
    const isFlipV = /\b(?:flip\s*vertical|upside\s*down)\b/i.test(lower);
    const isRotate90 = /\b(?:rotate\s*90|turn\s*right|clockwise)\b/i.test(lower);
    const isRotate180 = /\b(?:rotate\s*180|flip\s*180)\b/i.test(lower);
    const isRotate270 = /\b(?:rotate\s*270|rotate\s*-90|counter[\s-]*clockwise|turn\s*left)\b/i.test(lower);
    const isBrighter = /\b(?:brighter|brighten|lighter|exposure\s*up)\b/i.test(lower);
    const isDarker = /\b(?:darker|darken|dimmer|dim)\b/i.test(lower);
    const isWarm = /\b(?:warm|warmer|golden\s*tone)\b/i.test(lower);
    const isCool = /\b(?:cool|cooler|blue\s*tone|cold\s*tone)\b/i.test(lower);
    const isBlur = /\b(?:blur|blurry|soften)\b/i.test(lower);
    const isSharp = /\b(?:sharpen|crisp|enhance|improve|hd|clearer)\b/i.test(lower);
    const isVibrant = /\b(?:vibrant|saturated|pop|vivid|colorful)\b/i.test(lower);
    const isVignette = /\bvignette\b/i.test(lower);

    if (
      isBw || isSepia || isVintage || isInvert || isFlipH || isFlipV ||
      isRotate90 || isRotate180 || isRotate270 || isBrighter || isDarker ||
      isWarm || isCool || isBlur || isSharp || isVibrant || isVignette
    ) {
      return {
        mode: 'filter',
        grayscale: isBw,
        sepia: isSepia,
        vintage: isVintage,
        invert: isInvert,
        flipH: isFlipH,
        flipV: isFlipV,
        rotate: isRotate270 ? 270 : isRotate180 ? 180 : isRotate90 ? 90 : 0,
        brightness: isBrighter ? 0.12 : isDarker ? -0.14 : 0,
        contrast: isSharp || isVibrant ? 1.12 : 1,
        saturation: isVibrant ? 1.38 : 1,
        warmth: isWarm ? 0.16 : isCool ? -0.16 : 0,
        blur: isBlur ? 4.5 : 0,
        sharpen: isSharp ? 0.9 : 0.28,
        vignette: isVignette,
      };
    }
  }

  return {
    mode: 'img2img',
    strength: 0.58,
    editedPrompt: `Edited realistic 35mm DSLR photograph based on the reference image, ${editInstruction}, preserving the main subject identity, pose, and natural lighting cleanly`,
  };
}

async function planPhotoEditWithXkiro(
  sourceDataUrl: string,
  additionalDataUrls: string[],
  editInstruction: string
): Promise<PhotoEditPlan> {
  if (!XKIRO_API_KEY) {
    return buildFallbackPhotoEditPlan(editInstruction);
  }

  const plannerPrompt = `You are a precision photo-editing planner. Inspect the uploaded photo(s) carefully and read the user's edit request: "${editInstruction}".

Choose ONE mode:
1. "filter" — ONLY if the user asks purely for whole-image color, tone, brightness, contrast, saturation, grayscale/B&W, sepia, invert, vintage vignette, sharpen, whole-image blur, flip, or 90/180/270 degree rotation WITHOUT adding, removing, replacing, or altering any object, person, face, expression, clothing, background, weather, or art style.
2. "img2img" — for ALL content edits (changing clothes/hair/colors of objects, adding/removing objects or accessories, replacing background, changing lighting/weather/time-of-day, changing expression, or applying artistic styles like anime/oil painting).

Return ONLY a raw JSON object (no markdown fences, no commentary):
- For "filter":
  {"mode":"filter","grayscale":false,"sepia":false,"invert":false,"rotate":0,"flipH":false,"flipV":false,"brightness":0,"contrast":1,"saturation":1,"warmth":0,"blur":0,"sharpen":0.3,"vignette":false,"vintage":false,"cropAspect":null}
- For "img2img":
  {"mode":"img2img","strength":0.58,"targetAspect":null,"editedPrompt":"<45-85 word rich visual description of the FINAL edited photo. Describe the exact subject, face, hair, clothing, pose, composition, and setting visible in the uploaded photo, keeping everything unchanged EXCEPT applying the user's requested edit naturally.>"}

Strength guide for img2img: 0.44-0.54 for color/accessory tweaks, 0.56-0.64 for outfit/lighting/weather edits, 0.66-0.74 for background swap or full style conversion.`;

  const contentParts: any[] = [
    { type: 'text', text: plannerPrompt },
    { type: 'image_url', image_url: { url: sourceDataUrl } },
    ...additionalDataUrls.slice(0, 3).map((u) => ({
      type: 'image_url',
      image_url: { url: u },
    })),
  ];

  try {
    const aiRes = await callXkiroChat(
      [{ role: 'user', content: contentParts }],
      true
    );
    if (aiRes?.content) {
      const jsonMatch = aiRes.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed?.mode === 'filter') {
          const rot = Number(parsed.rotate);
          return {
            mode: 'filter',
            grayscale: Boolean(parsed.grayscale),
            sepia: Boolean(parsed.sepia),
            invert: Boolean(parsed.invert),
            rotate: rot === 90 || rot === 180 || rot === 270 ? rot : 0,
            flipH: Boolean(parsed.flipH),
            flipV: Boolean(parsed.flipV),
            brightness: Number(parsed.brightness) || 0,
            contrast: Number(parsed.contrast) || 1,
            saturation: parsed.saturation !== undefined ? Number(parsed.saturation) : 1,
            warmth: Number(parsed.warmth) || 0,
            blur: Number(parsed.blur) || 0,
            sharpen: parsed.sharpen !== undefined ? Number(parsed.sharpen) : 0.3,
            vignette: Boolean(parsed.vignette),
            vintage: Boolean(parsed.vintage),
            cropAspect:
              parsed.cropAspect === '1:1' ||
              parsed.cropAspect === '16:9' ||
              parsed.cropAspect === '9:16' ||
              parsed.cropAspect === '4:3' ||
              parsed.cropAspect === '3:4'
                ? parsed.cropAspect
                : null,
          };
        }
        if (parsed?.mode === 'img2img' && typeof parsed.editedPrompt === 'string' && parsed.editedPrompt.trim().length > 10) {
          const strength = Math.max(0.38, Math.min(0.76, Number(parsed.strength) || 0.58));
          const targetAspect =
            parsed.targetAspect === '1:1' ||
            parsed.targetAspect === '16:9' ||
            parsed.targetAspect === '9:16' ||
            parsed.targetAspect === '4:3' ||
            parsed.targetAspect === '3:4'
              ? parsed.targetAspect
              : null;
          return {
            mode: 'img2img',
            editedPrompt: parsed.editedPrompt.trim().slice(0, 650),
            strength,
            targetAspect,
          };
        }
      }
    }
  } catch (err: any) {
    console.warn('Photo edit planner fallback:', err?.message || err);
  }

  return buildFallbackPhotoEditPlan(editInstruction);
}

// AI Horde native img2img worker anchored to the user's actual uploaded photo pixels
async function generateAiHordeImg2ImgBuffer(
  sourceBuffer: Buffer,
  editedPrompt: string,
  aspectRatio: PhotoAspectOption,
  denoisingStrength: number
): Promise<Buffer | null> {
  const [hordeW, hordeH] =
    aspectRatio === '16:9'
      ? [640, 384]
      : aspectRatio === '9:16'
      ? [384, 640]
      : aspectRatio === '4:3'
      ? [576, 448]
      : aspectRatio === '3:4'
      ? [448, 576]
      : [512, 512];

  const normalizedSource = await prepareNormalizedSourceBuffer(sourceBuffer, hordeW, hordeH, 'png');
  const primarySource = normalizedSource || sourceBuffer;

  let hordeModels = [
    'Deliberate',
    'Realistic Vision',
    "ICBINP - I Can't Believe It's Not Photography",
    'Edge Of Realism',
    'majicMIX realistic',
    'stable_diffusion',
  ];
  try {
    const modelsRes = await fetch('https://stablehorde.net/api/v2/status/models?type=image', {
      signal: AbortSignal.timeout(2500),
    });
    if (modelsRes.ok) {
      const list: any[] = await modelsRes.json();
      const fastReal = list
        .filter(
          (m) =>
            m?.count > 0 &&
            typeof m?.name === 'string' &&
            !/inpaint|xl|pony|flux/i.test(m.name) &&
            /edge of realism|majicmix|realistic vision|icbinp|deliberate|ether real|epic diffusion|dreamshaper|absolutereality|stable_diffusion/i.test(
              m.name
            ) &&
            Number(m?.eta ?? 999) <= 45
        )
        .sort((a, b) => Number(a.eta) - Number(b.eta) || Number(b.count) - Number(a.count))
        .slice(0, 6)
        .map((m) => m.name as string);
      if (fastReal.length > 0) {
        if (!fastReal.includes('stable_diffusion')) {
          fastReal.push('stable_diffusion');
        }
        hordeModels = fastReal;
      }
    }
  } catch {}

  const submitImg2Img = (imgBuf: Buffer, w: number, h: number, steps: number, models: string[]) =>
    fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: '0000000000',
        'Client-Agent': 'BloopX:1.0:server',
      },
      body: JSON.stringify({
        prompt: `${editedPrompt} ### blurry, deformed, bad anatomy, watermark, text, low quality`,
        source_image: imgBuf.toString('base64'),
        source_processing: 'img2img',
        params: {
          width: w,
          height: h,
          steps,
          denoising_strength: Number(denoisingStrength.toFixed(2)),
          n: 1,
          cfg_scale: 7.5,
          sampler_name: 'k_euler',
        },
        models,
        nsfw: false,
        censor_nsfw: true,
        r2: true,
      }),
      signal: AbortSignal.timeout(8000),
    });

  try {
    let submitRes = await submitImg2Img(primarySource, hordeW, hordeH, 16, hordeModels);
    if (submitRes.status === 403) {
      const squareFallback =
        hordeW === 512 && hordeH === 512
          ? primarySource
          : await prepareNormalizedSourceBuffer(sourceBuffer, 512, 512, 'png');
      if (squareFallback) {
        submitRes = await submitImg2Img(
          squareFallback,
          512,
          512,
          12,
          ['Deliberate', 'Realistic Vision', 'stable_diffusion']
        );
      }
    }

    if (!submitRes.ok) {
      const errTxt = await submitRes.text().catch(() => '');
      console.warn(`AI Horde img2img HTTP ${submitRes.status}: ${errTxt.slice(0, 140)}`);
      return null;
    }

    const submitJson: any = await submitRes.json();
    const jobId = submitJson?.id;
    if (!jobId) return null;

    for (let poll = 0; poll < 42; poll++) {
      await new Promise((r) => setTimeout(r, 1250));
      try {
        const checkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!checkRes.ok) continue;
        const checkJson: any = await checkRes.json();
        if (checkJson?.faulted) return null;
        if (checkJson?.done) {
          const statusRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${jobId}`, {
            signal: AbortSignal.timeout(8000),
          });
          if (!statusRes.ok) return null;
          const statusJson: any = await statusRes.json();
          const imgRef = statusJson?.generations?.[0]?.img;
          if (!imgRef || typeof imgRef !== 'string') return null;

          if (imgRef.startsWith('http://') || imgRef.startsWith('https://')) {
            const imgRes = await fetch(imgRef, { signal: AbortSignal.timeout(10000) });
            if (!imgRes.ok) return null;
            const buf = Buffer.from(await imgRes.arrayBuffer());
            return buf.length > 4000 ? buf : null;
          }
          const rawB64 = imgRef.includes(',') ? imgRef.split(',')[1] : imgRef;
          const buf = Buffer.from(rawB64, 'base64');
          return buf.length > 4000 ? buf : null;
        }
      } catch {}
    }
  } catch (err: any) {
    console.warn('AI Horde img2img error:', err?.message || err);
  }
  return null;
}

async function editPhotoWithSenseNova(
  sourceBuffer: Buffer,
  sourceMime: string,
  additionalImages: Array<{ data: string; mimeType: string }>,
  editInstruction: string,
  requestedAspect: PhotoAspectOption,
  quality: PhotoQualityOption
): Promise<{ buffer: Buffer; mimeType: string; aspectRatio: PhotoAspectOption; provider: string } | null> {
  // Detect uploaded photo's natural aspect ratio so portrait/landscape photos aren't unexpectedly cropped
  const dims = await probeImageDimensions(sourceBuffer);
  const naturalAspect = dims ? pickClosestPhotoAspect(dims.width, dims.height) : requestedAspect;

  const sourceDataUrl = `data:${sourceMime};base64,${sourceBuffer.toString('base64')}`;
  const additionalDataUrls = additionalImages.map((img) => `data:${img.mimeType};base64,${img.data}`);

  const plan = await planPhotoEditWithXkiro(sourceDataUrl, additionalDataUrls, editInstruction);

  if (plan.mode === 'filter') {
    let effectiveAspect = plan.cropAspect || naturalAspect;
    if (plan.rotate === 90 || plan.rotate === 270) {
      if (effectiveAspect === '16:9') effectiveAspect = '9:16';
      else if (effectiveAspect === '9:16') effectiveAspect = '16:9';
      else if (effectiveAspect === '4:3') effectiveAspect = '3:4';
      else if (effectiveAspect === '3:4') effectiveAspect = '4:3';
    }
    const { width, height, jpegQ } = getPhotoDimensions(effectiveAspect, quality);
    const filtered = await applyFfmpegPhotoFilters(sourceBuffer, plan, width, height, jpegQ);
    if (filtered) {
      return {
        ...filtered,
        aspectRatio: effectiveAspect,
        provider: XKIRO_API_KEY ? 'Xkiro-SenseNova-Editor' : 'BloopX-Photo-Editor',
      };
    }
  }

  const img2imgPlan: PhotoImg2ImgPlan =
    plan.mode === 'img2img'
      ? plan
      : {
          mode: 'img2img',
          editedPrompt: `Edited realistic 35mm DSLR photograph based on the reference image, ${editInstruction}`,
          strength: 0.58,
          targetAspect: naturalAspect,
        };

  const effectiveAspect = img2imgPlan.targetAspect || naturalAspect;
  const { width, height, jpegQ } = getPhotoDimensions(effectiveAspect, quality);

  const editedRaw = await generateAiHordeImg2ImgBuffer(
    sourceBuffer,
    img2imgPlan.editedPrompt,
    effectiveAspect,
    img2imgPlan.strength
  );
  if (editedRaw) {
    const formatted = await enhanceAndFormatPhoto(editedRaw, 'image/webp', width, height, jpegQ);
    return {
      ...formatted,
      aspectRatio: effectiveAspect,
      provider: XKIRO_API_KEY ? 'Xkiro-SenseNova-Edit-SDXL' : 'Photo-Edit-Img2Img',
    };
  }

  return null;
}

// AI Photo Generation & Editing Endpoint honoring user-selected aspectRatio & quality
app.post('/api/generate-image', async (req, res) => {
  const {
    prompt,
    aspectRatio: rawAspect,
    quality: rawQuality,
    sourceImage,
    additionalImages,
  } = req.body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const clientHfToken = ((req.headers['x-hf-token'] as string) || '').trim();
  const cleanPrompt = prompt.trim().slice(0, 1200);
  const aspectRatio = normalizePhotoAspect(rawAspect);
  const quality = normalizePhotoQuality(rawQuality);

  // If user uploaded a source photo in Photo mode, execute real Vision-guided photo editing
  if (sourceImage && typeof sourceImage.data === 'string' && sourceImage.data.length > 0) {
    if (sourceImage.data.length > 25_000_000) {
      return res.status(400).json({ error: 'Uploaded image is too large. Please use an image under 15MB.' });
    }
    const rawMime = typeof sourceImage.mimeType === 'string' ? sourceImage.mimeType : 'image/jpeg';
    if (!rawMime.startsWith('image/')) {
      return res.status(400).json({ error: 'Invalid source image MIME type.' });
    }
    const cleanB64 = sourceImage.data.includes(',') ? sourceImage.data.split(',')[1] : sourceImage.data;
    const sourceBuffer = Buffer.from(cleanB64, 'base64');
    if (sourceBuffer.length < 100) {
      return res.status(400).json({ error: 'Invalid uploaded image data.' });
    }

    const safeExtras = Array.isArray(additionalImages)
      ? additionalImages
          .filter(
            (img: any) =>
              img &&
              typeof img.data === 'string' &&
              img.data.length > 0 &&
              img.data.length < 15_000_000 &&
              typeof img.mimeType === 'string' &&
              img.mimeType.startsWith('image/')
          )
          .slice(0, 3)
          .map((img: any) => ({
            data: img.data.includes(',') ? img.data.split(',')[1] : img.data,
            mimeType: img.mimeType,
          }))
      : [];

    const edited = await editPhotoWithSenseNova(
      sourceBuffer,
      rawMime,
      safeExtras,
      cleanPrompt,
      aspectRatio,
      quality
    );
    if (edited) {
      const b64 = edited.buffer.toString('base64');
      return res.json({
        imageUrl: `data:${edited.mimeType};base64,${b64}`,
        prompt: cleanPrompt,
        aspectRatio: edited.aspectRatio,
        quality,
        edited: true,
        provider: edited.provider,
      });
    }

    return res.status(200).json({
      imageUrl: null,
      cooldown: true,
    });
  }

  const { compiledPrompt, directImageUri } = await compileStrictRealisticPrompt(cleanPrompt, clientHfToken);
  if (directImageUri) {
    return res.json({
      imageUrl: directImageUri,
      prompt: cleanPrompt,
      aspectRatio,
      quality,
      provider: 'Xkiro-Photo',
    });
  }

  const rendered = await generateReliablePhoto(compiledPrompt, aspectRatio, quality, clientHfToken);
  if (rendered) {
    const b64 = rendered.buffer.toString('base64');
    return res.json({
      imageUrl: `data:${rendered.mimeType};base64,${b64}`,
      prompt: cleanPrompt,
      aspectRatio,
      quality,
      provider: rendered.provider,
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
      const quotaExceeded =
        /ZeroGPU quota|exceeded your.*quota/i.test(fullText) ||
        /event:\s*error\s*\r?\n\s*data:\s*null\b/i.test(fullText);
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

// Plan 2-3 cohesive temporal camera keyframes via Xkiro SenseNova for reliable cinematic MP4 synthesis
async function planVideoStoryboardFrames(
  rawPrompt: string,
  frameCount: number
): Promise<string[]> {
  const cleanSubject = rawPrompt.trim().slice(0, 500);
  const fallbackFrames =
    frameCount <= 2
      ? [
          `Cinematic 35mm establishing wide shot of ${cleanSubject}, dramatic natural lighting, crisp depth of field, authentic live-action photography`,
          `Cinematic 35mm dynamic close-up continuation of ${cleanSubject} in motion, warm golden rim lighting, rich textures, authentic live-action photography`,
        ]
      : [
          `Cinematic 35mm opening wide shot of ${cleanSubject}, atmospheric natural lighting, authentic live-action photography`,
          `Cinematic 35mm mid-action dynamic tracking shot of ${cleanSubject}, vivid natural motion, crisp optical focus, authentic live-action photography`,
          `Cinematic 35mm golden atmospheric closing shot of ${cleanSubject}, dramatic light rays and natural depth, authentic live-action photography`,
        ];

  if (!XKIRO_API_KEY) {
    return fallbackFrames;
  }

  try {
    const directorSystem = `You are a film director creating ${frameCount} sequential keyframe still descriptions for a ${
      frameCount <= 2 ? '5-second' : '10-second'
    } live-action video about: "${cleanSubject}".
Keep the EXACT same setting, subject identity, weather, and lighting across every frame while advancing the camera angle and physical action smoothly from start to finish.
Return ONLY a JSON array of ${frameCount} strings (each 22-40 words, photorealistic live-action 35mm film still description, no markdown).`;

    const aiRes = await Promise.race([
      callXkiroChat(
        [
          { role: 'system', content: directorSystem },
          { role: 'user', content: cleanSubject },
        ],
        false
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
    ]);
    if (aiRes?.content) {
      const match = aiRes.content.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (
          Array.isArray(parsed) &&
          parsed.length >= frameCount &&
          parsed.slice(0, frameCount).every((s) => typeof s === 'string' && s.trim().length > 10)
        ) {
          return parsed.slice(0, frameCount).map((s: string) => s.trim().slice(0, 400));
        }
      }
    }
  } catch (err: any) {
    console.warn('Video storyboard planner fallback:', err?.message || err);
  }

  return fallbackFrames;
}

// Fast jitter-free 30fps FFmpeg cinematic motion compositing (oversampled smooth zoom/pan + crossfade)
async function composeCinematicMp4FromKeyframes(
  frameBuffers: Buffer[],
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  if (frameBuffers.length === 0) return null;

  const fileId = `vid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const tempPaths: string[] = [];
  const finalOutPath = path.join(GENERATED_VIDEOS_DIR, `${fileId}.mp4`);

  const targetFps = 30;
  const { outW, outH, crf, maxrate, bufsize } = getVideoResolutionConfig(
    aspectRatio,
    quality,
    targetSeconds
  );
  // 2x oversampling eliminates zoompan subpixel shimmer cleanly while keeping encoding fast
  const osW = Math.min(2560, outW * 2);
  const osH = Math.min(2560, outH * 2);

  try {
    const framesToUse =
      frameBuffers.length >= 2 ? frameBuffers.slice(0, 3) : [frameBuffers[0], frameBuffers[0]];

    for (let i = 0; i < framesToUse.length; i++) {
      const p = path.join(os.tmpdir(), `${fileId}_kf_${i}.jpg`);
      await fs.promises.writeFile(p, framesToUse[i]);
      tempPaths.push(p);
    }

    const n = framesToUse.length;
    const xfadeDur = 0.65;
    // Ensure total output duration equals targetSeconds cleanly after xfade overlaps
    const clipSec = (targetSeconds + xfadeDur * (n - 1)) / n;
    const segFrames = Math.max(30, Math.round(clipSec * targetFps));

    const inputArgs: string[] = [];
    for (const p of tempPaths) {
      inputArgs.push('-i', p);
    }

    const filterParts: string[] = [];
    for (let i = 0; i < n; i++) {
      const prep = `[${i}:v]scale=${osW}:${osH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${osW}:${osH},setsar=1`;
      let motion = '';
      if (i % 3 === 0) {
        // Smooth push-in
        motion = `zoompan=z='1+0.12*(on/${segFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${segFrames}:s=${outW}x${outH}:fps=${targetFps}`;
      } else if (i % 3 === 1) {
        // Smooth horizontal camera pan
        motion = `zoompan=z='1.12':x='(iw-iw/zoom)*(on/${segFrames})':y='ih/2-(ih/zoom/2)':d=${segFrames}:s=${outW}x${outH}:fps=${targetFps}`;
      } else {
        // Smooth pull-out
        motion = `zoompan=z='1.12-0.12*(on/${segFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${segFrames}:s=${outW}x${outH}:fps=${targetFps}`;
      }
      filterParts.push(`${prep},${motion},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
    }

    let finalLabel = '[v0]';
    if (n === 2) {
      const offset1 = Math.max(0.5, clipSec - xfadeDur).toFixed(3);
      filterParts.push(
        `[v0][v1]xfade=transition=fade:duration=${xfadeDur}:offset=${offset1},unsharp=5:5:0.24:5:5:0.0,format=yuv420p[vout]`
      );
      finalLabel = '[vout]';
    } else if (n >= 3) {
      const offset1 = Math.max(0.5, clipSec - xfadeDur).toFixed(3);
      const offset2 = Math.max(1.0, clipSec * 2 - xfadeDur * 2).toFixed(3);
      filterParts.push(
        `[v0][v1]xfade=transition=fade:duration=${xfadeDur}:offset=${offset1}[vx1]`,
        `[vx1][v2]xfade=transition=smoothleft:duration=${xfadeDur}:offset=${offset2},unsharp=5:5:0.24:5:5:0.0,format=yuv420p[vout]`
      );
      finalLabel = '[vout]';
    }

    const totalTargetFrames = Math.round(targetSeconds * targetFps);
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '0',
      ...inputArgs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      finalLabel,
      '-an',
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
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      finalOutPath,
    ];

    onProgress?.(78);
    await runFfmpegWithProgress(args, totalTargetFrames, 65000, (ratio) => {
      onProgress?.(Math.min(99, Math.round(78 + ratio * 21)));
    });

    const stat = await fs.promises.stat(finalOutPath);
    if (stat.size > 10000) {
      onProgress?.(100);
      return `/api/videos/${fileId}.mp4`;
    }
  } catch (err: any) {
    console.warn('Cinematic storyboard FFmpeg synthesis error:', err?.message || err);
  } finally {
    for (const p of tempPaths) {
      fs.promises.unlink(p).catch(() => {});
    }
  }

  return null;
}

// Reliable Failover (when remote ZeroGPU video Spaces exhaust daily IP quota):
// Xkiro SenseNova Storyboard + parallel keyframe synthesis + 30fps smooth motion mastering
async function generateCinematicStoryboardVideoFallback(
  rawPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  try {
    onProgress?.(18);
    const frameCount = targetSeconds === 5 ? 2 : 3;
    const scenePrompts = await planVideoStoryboardFrames(rawPrompt, frameCount);
    onProgress?.(28);

    const photoAspect: PhotoAspectOption = aspectRatio;
    const photoQuality: PhotoQualityOption = quality === '1080p' ? 'hd' : 'standard';

    let completedCount = 0;
    const frameResults = await Promise.all(
      scenePrompts.map(async (scenePrompt) => {
        const rendered = await generateReliablePhoto(scenePrompt, photoAspect, photoQuality);
        completedCount += 1;
        onProgress?.(Math.min(72, Math.round(28 + (completedCount / scenePrompts.length) * 44)));
        return rendered?.buffer || null;
      })
    );

    const validFrames = frameResults.filter((b): b is Buffer => Boolean(b && b.length > 5000));
    if (validFrames.length === 0) return null;

    return await composeCinematicMp4FromKeyframes(
      validFrames,
      targetSeconds,
      aspectRatio,
      quality,
      onProgress
    );
  } catch (err: any) {
    console.warn('Storyboard video fallback error:', err?.message || err);
    return null;
  }
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

    // Tier 5: Fast ZeroGPU-independent Xkiro-directed storyboard motion MP4 synthesis
    const storyboardUrl = await generateCinematicStoryboardVideoFallback(
      job.prompt,
      job.duration,
      job.aspectRatio,
      job.quality,
      updateProgress
    );
    if (storyboardUrl) {
      job.progress = 100;
      job.status = 'completed';
      job.videoUrl = storyboardUrl;
      job.model = 'Xkiro-SenseNova-Motion';
      return;
    }

    job.status = 'failed';
    job.error = 'Video generation servers are currently busy. Please try again in a moment.';
  } catch (err: any) {
    job.status = 'failed';
    job.error = err?.message || 'Unable to complete video generation.';
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

// Plan storyboard keyframes quickly (<2.5s) for ZeroGPU-independent Tier 5 video fallback
app.post('/api/video-storyboard', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const frameCount = Number(req.body?.frameCount) === 2 ? 2 : 3;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  try {
    const framePrompts = await planVideoStoryboardFrames(prompt, frameCount);
    return res.json({ framePrompts });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Unable to plan storyboard frames.' });
  }
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


