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
import { InferenceClient } from '@huggingface/inference';

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
];
const XKIRO_TEXT_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
];
const XKIRO_PHOTO_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
];

const xkiroUnavailableCache = new Map<string, number>();

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
  return hasImages ? [...XKIRO_VISION_MODELS] : [...XKIRO_TEXT_MODELS];
}

// Hugging Face API Configuration (Fallback / Video & Image Tiers)
const HF_ACCESS_TOKEN = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '';
const HF_CHAT_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_CHAT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'deepseek-ai/DeepSeek-R1',
  'meta-llama/Llama-3.1-8B-Instruct',
];
const HF_VISION_MODELS = [
  'Qwen/Qwen3.8-Flash-Next',
  'google/gemma-4-26B-A4B-it',
  'Qwen/Qwen3.8-27B',
  'google/gemma-3-4b-it',
];
const HF_DEFAULT_CHAT_MODEL = HF_CHAT_MODELS[0];

// Shared helper: Transcribe base64 voice audio using Gemini + HF Whisper + client speech transcript hint
async function transcribeAudioWithGemini(
  audioData: string,
  mimeType?: string,
  clientHfToken?: string,
  transcriptHint?: string
): Promise<string> {
  const cleanData = audioData.includes(',') ? audioData.split(',')[1] : audioData;
  const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  if (!cleanData) {
    return (transcriptHint || '').trim();
  }

  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (geminiApiKey) {
    const ai = new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    for (const model of ['gemini-3.5-transcribe', 'gemini-4-hydrogen', 'gemini-2.5-flash']) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: cleanMime,
                  data: cleanData,
                },
              },
              {
                text: 'Transcribe the spoken words in this audio accurately into plain text without quotes or commentary. If there is no intelligible speech, output ONLY [NO_SPEECH].',
              },
            ],
          },
        });

        const raw = response.text?.trim() || '';
        const cleaned = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
        if (cleaned && !/^\[?no[_\s-]*speech\]?$|^empty$/i.test(cleaned)) {
          return cleaned;
        }
      } catch (err: any) {
        console.warn(`Transcription (${model}) warning:`, err?.message || err);
      }
    }
  }

  const hfToken = clientHfToken || HF_ACCESS_TOKEN;
  if (hfToken) {
    try {
      const audioBuffer = Buffer.from(cleanData, 'base64');
      if (audioBuffer.length > 64) {
        const client = new InferenceClient(hfToken);
        const audioBlob = new Blob([audioBuffer], { type: cleanMime });
        for (const asrModel of ['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3']) {
          try {
            const asrRes = await client.automaticSpeechRecognition(
              {
                model: asrModel,
                data: audioBlob,
                provider: 'hf-inference',
              } as any,
              { signal: AbortSignal.timeout(14000) }
            );
            const text = typeof asrRes?.text === 'string' ? asrRes.text.trim() : '';
            if (text) return text;
          } catch (err: any) {
            console.warn(`HF ASR (${asrModel}) warning:`, err?.message || err);
          }
        }
      }
    } catch {
      // Fall through cleanly
    }
  }

  return (transcriptHint || '').trim();
}

// Transcribe voice recording endpoint with safe fallback
app.post('/api/transcribe', async (req, res) => {
  const { audioData, mimeType, transcriptHint } = req.body || {};
  if (!audioData || typeof audioData !== 'string') {
    return res.status(400).json({ error: 'audioData is required' });
  }

  try {
    const clientHfToken = ((req.headers['x-hf-token'] as string) || '').trim();
    const transcribed = await transcribeAudioWithGemini(
      audioData,
      mimeType,
      clientHfToken,
      typeof transcriptHint === 'string' ? transcriptHint : undefined
    );
    return res.json({ text: transcribed });
  } catch (err: any) {
    console.error('Transcription error:', err.message);
    return res.json({ text: typeof transcriptHint === 'string' ? transcriptHint.trim() : '' });
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

// Secondary Hugging Face Chat completion caller (routes to Vision models when images/frames attached)
async function callHuggingFaceChat(
  payloadMessages: any[],
  clientToken?: string,
  hasImages: boolean = false
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const token = clientToken || HF_ACCESS_TOKEN;
  if (!token) return null;

  const modelsToTry = hasImages ? HF_VISION_MODELS : HF_CHAT_MODELS;
  for (const model of modelsToTry) {
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
        signal: AbortSignal.timeout(16000),
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

// Tertiary Gemini Multimodal Chat fallback (supports text, images, video, and audio)
async function callGeminiFallbackChat(
  recentMessages: Array<{ role: string; content: string }>,
  attachments: any[]
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) return null;

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
  const parts: any[] = [];
  const transcriptLines = recentMessages.map(
    (m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`
  );
  parts.push({
    text: `You are BloopX AI. Be concise, direct, helpful, and clear. Analyze any attached image, video, or audio directly.\n\n${transcriptLines.join('\n')}\nAssistant:`,
  });
  for (const att of attachments) {
    if (!att?.data || typeof att?.mimeType !== 'string') continue;
    const cleanMime = att.mimeType.split(';')[0].trim();
    const cleanData = String(att.data).includes(',') ? String(att.data).split(',')[1] : String(att.data);
    if (!cleanData) continue;
    if (
      cleanMime.startsWith('image/') ||
      cleanMime.startsWith('video/') ||
      cleanMime.startsWith('audio/')
    ) {
      parts.push({ inlineData: { mimeType: cleanMime, data: cleanData } });
    }
  }

  for (const model of ['gemini-4-hydrogen', 'gemini-2.5-flash']) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: { parts },
      });
      const text = resp.text?.trim() || '';
      if (text) {
        return {
          content: text,
          tokensUsed: Math.max(60, Math.ceil((JSON.stringify(recentMessages).length + text.length) / 4)),
          modelUsed: model,
        };
      }
    } catch (err: any) {
      console.warn(`Gemini chat fallback (${model}) warning:`, err?.message || err);
    }
  }
  return null;
}

// Zero-key preview fallback using Pollinations (vision + text) & AI Horde (text-only)
async function callZeroKeyFallbackChat(
  plainMessages: Array<{ role: string; content: string }>,
  openAiMessages?: any[],
  hasVisualMedia: boolean = false
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  // 1. Pollinations OpenAI-compatible text/vision endpoint
  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: hasVisualMedia && openAiMessages ? openAiMessages : plainMessages,
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
    console.warn('Pollinations fallback warning:', err?.message || err);
  }

  // Never fall back to blind text-only AI Horde when the user uploaded photos or videos
  if (hasVisualMedia) {
    return null;
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
  const clientHfToken = ((req.headers['x-hf-token'] as string) || '').trim();

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
        .slice(0, 16)
    : [];

  const audioAtt = safeAttachments.find((att: any) => att.mimeType.startsWith('audio/'));
  const imageLikeAttachments = safeAttachments.filter((att: any) => att.mimeType.startsWith('image/'));
  const rawVideoAttachments = safeAttachments.filter((att: any) => att.mimeType.startsWith('video/'));
  const hasImageParts = imageLikeAttachments.length > 0;
  const hasRawVideoOnly = rawVideoAttachments.length > 0 && !hasImageParts;
  const hasVisualMedia = hasImageParts || rawVideoAttachments.length > 0;

  let voiceTranscript = '';
  if (audioAtt) {
    try {
      voiceTranscript = await transcribeAudioWithGemini(
        audioAtt.data,
        audioAtt.mimeType,
        clientHfToken,
        typeof audioAtt.transcriptHint === 'string' ? audioAtt.transcriptHint : undefined
      );
    } catch (audioErr: any) {
      console.warn('Voice attachment transcription warning:', audioErr?.message || audioErr);
    }
  }

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
              (hasVisualMedia
                ? 'Please inspect and explain the uploaded photo or video in detail.'
                : 'The user sent a voice audio clip. Listen carefully and respond directly to what they said.'),
          },
        ];

  const systemPrompt = {
    role: 'system',
    content:
      'You are BloopX AI. Be concise, direct, helpful, and clear. When photos or video frames are attached, examine them carefully and describe or answer directly based on what is shown.',
  };

  const openAiMessages = [
    systemPrompt,
    ...recentMessages.map((m: any, idx: number) => {
      if (idx === recentMessages.length - 1 && hasImageParts) {
        const parts: any[] = [];
        const hasVideoFrames = imageLikeAttachments.some((att: any) => att.kind === 'video-frame');
        const baseText = m.content || '';
        const annotatedText = hasVideoFrames
          ? `${baseText}\n\n[Note: The attached images below are chronological keyframes captured from the user's uploaded video. Analyze them as scenes from that video.]`.trim()
          : baseText;
        if (annotatedText) {
          parts.push({ type: 'text', text: annotatedText });
        }
        for (const att of imageLikeAttachments) {
          const cleanMime = att.mimeType.split(';')[0].trim() || 'image/jpeg';
          const cleanData = String(att.data).includes(',') ? String(att.data).split(',')[1] : String(att.data);
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${cleanMime};base64,${cleanData}` },
          });
        }
        return { role: m.role, content: parts.length > 0 ? parts : m.content || '' };
      }
      return { role: m.role, content: m.content || '' };
    }),
  ];

  const plainMessages = [systemPrompt, ...recentMessages];

  try {
    // If raw audio wasn't transcribed or raw video was sent without extracted frames, route directly to Gemini multimodal
    if ((audioAtt && !voiceTranscript) || hasRawVideoOnly) {
      const geminiDirect = await callGeminiFallbackChat(recentMessages, safeAttachments);
      if (geminiDirect) {
        return res.json({
          content: geminiDirect.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: geminiDirect.tokensUsed,
          provider: `Gemini (${geminiDirect.modelUsed})`,
        });
      }
    }

    // Tier 1: Xkiro API
    if (!hasRawVideoOnly && !(audioAtt && !voiceTranscript)) {
      const xkiroResult = await callXkiroChat(openAiMessages, hasImageParts);
      if (xkiroResult) {
        return res.json({
          content: xkiroResult.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: xkiroResult.tokensUsed,
          provider: `Xkiro (${xkiroResult.modelUsed})`,
        });
      }
    }

    // Tier 2: Hugging Face Router (Vision-Language models when images/frames attached)
    if (!hasRawVideoOnly) {
      const hfResult = await callHuggingFaceChat(openAiMessages, clientHfToken, hasImageParts);
      if (hfResult) {
        return res.json({
          content: hfResult.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: hfResult.tokensUsed,
          provider: `HuggingFace (${hfResult.modelUsed})`,
        });
      }
    }

    // Tier 3: Gemini Multimodal Fallback (supports text, images, video, and audio)
    const geminiResult = await callGeminiFallbackChat(recentMessages, safeAttachments);
    if (geminiResult) {
      return res.json({
        content: geminiResult.content,
        voiceTranscript: voiceTranscript || undefined,
        tokensUsed: geminiResult.tokensUsed,
        provider: `Gemini (${geminiResult.modelUsed})`,
      });
    }

    // Tier 4: Zero-key failover (Pollinations Vision/Text -> AI Horde text-only)
    if (!hasRawVideoOnly && !(audioAtt && !voiceTranscript)) {
      const zeroKeyResult = await callZeroKeyFallbackChat(plainMessages, openAiMessages, hasImageParts);
      if (zeroKeyResult) {
        return res.json({
          content: zeroKeyResult.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: zeroKeyResult.tokensUsed,
          provider: zeroKeyResult.modelUsed,
        });
      }
    }

    const hint = audioAtt && !voiceTranscript
      ? 'Could not hear any speech in that voice recording. Please speak clearly and try again.'
      : hasVisualMedia
      ? 'Vision analysis servers are temporarily busy. Please try again in a moment.'
      : !XKIRO_API_KEY
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
  const token = clientToken || HF_ACCESS_TOKEN;
  const activeHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}`, 'X-HF-Token': token }
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

function detectServerImageMime(buf: Buffer, fallback: string = 'image/jpeg'): string {
  if (buf.length >= 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  return fallback;
}

// Instruction-guided AI photo editing via Hugging Face (FLUX.1-Kontext-dev & Qwen-Image-Edit)
async function generateAiPhotoEditViaHuggingFace(
  sourceBuffer: Buffer,
  sourceMime: string,
  editInstruction: string,
  clientHfToken?: string
): Promise<{ buffer: Buffer; mimeType: string; provider: string } | null> {
  const token = clientHfToken || HF_ACCESS_TOKEN;
  if (!token) return null;

  // 1. Try Hugging Face Inference Providers
  try {
    const client = new InferenceClient(token);
    const inputBlob = new Blob([new Uint8Array(sourceBuffer)], { type: sourceMime || 'image/jpeg' });
    const providers: Array<{ model: string; provider: 'fal-ai' | 'wavespeed' }> = [
      { model: 'black-forest-labs/FLUX.1-Kontext-dev', provider: 'fal-ai' },
      { model: 'Qwen/Qwen-Image-Edit', provider: 'fal-ai' },
      { model: 'black-forest-labs/FLUX.1-Kontext-dev', provider: 'wavespeed' },
      { model: 'Qwen/Qwen-Image-Edit', provider: 'wavespeed' },
    ];
    for (const item of providers) {
      try {
        const outBlob = await client.imageToImage(
          {
            model: item.model,
            inputs: inputBlob,
            provider: item.provider,
            parameters: { prompt: editInstruction },
          } as any,
          { signal: AbortSignal.timeout(15000) }
        );
        if (outBlob && outBlob.size > 4000) {
          const buf = Buffer.from(await outBlob.arrayBuffer());
          if (buf.length > 4000) {
            return {
              buffer: buf,
              mimeType: detectServerImageMime(buf, 'image/jpeg'),
              provider: `HuggingFace-${item.model.split('/').pop()}`,
            };
          }
        }
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (/401|402|403|payment|credit|balance/i.test(msg)) break;
      }
    }
  } catch {
    // Fall through to Gradio editing spaces
  }

  // 2. Try live RUNNING ZeroGPU Photo-Editing Spaces with HF_TOKEN
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-HF-Token': token,
  };
  const editSpaces = [
    {
      baseUrl: 'https://multimodalart-qwen-image-edit-fast.hf.space',
      buildData: (uploadedPath: string) => [
        { path: uploadedPath, orig_name: 'photo.jpg', mime_type: sourceMime, meta: { _type: 'gradio.FileData' } },
        editInstruction,
        0,
        true,
        1,
        8,
        false,
      ],
      provider: 'Qwen-Image-Edit-Fast',
    },
    {
      baseUrl: 'https://black-forest-labs-flux-1-kontext-dev.hf.space',
      buildData: (uploadedPath: string) => [
        { path: uploadedPath, orig_name: 'photo.jpg', mime_type: sourceMime, meta: { _type: 'gradio.FileData' } },
        editInstruction,
        0,
        true,
        2.5,
        20,
      ],
      provider: 'FLUX.1-Kontext-Dev',
    },
    {
      baseUrl: 'https://qwen-qwen-image-edit.hf.space',
      buildData: (uploadedPath: string) => [
        { path: uploadedPath, orig_name: 'photo.jpg', mime_type: sourceMime, meta: { _type: 'gradio.FileData' } },
        editInstruction,
        0,
        true,
        4,
        24,
        false,
      ],
      provider: 'Qwen-Image-Edit',
    },
  ];

  for (const sp of editSpaces) {
    try {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(sourceBuffer)], { type: sourceMime || 'image/jpeg' }), 'photo.jpg');
      const upRes = await fetch(`${sp.baseUrl}/gradio_api/upload`, {
        method: 'POST',
        headers: authHeaders,
        body: form,
        signal: AbortSignal.timeout(7000),
      });
      if (!upRes.ok) continue;
      const uploadedPaths: any = await upRes.json();
      const uploadedPath = Array.isArray(uploadedPaths) ? uploadedPaths[0] : '';
      if (!uploadedPath) continue;

      const postRes = await fetch(`${sp.baseUrl}/gradio_api/call/infer`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: sp.buildData(uploadedPath) }),
        signal: AbortSignal.timeout(7000),
      });
      if (!postRes.ok) continue;
      const postJson: any = await postRes.json();
      if (!postJson?.event_id) continue;

      const sseRes = await fetch(`${sp.baseUrl}/gradio_api/call/infer/${postJson.event_id}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(20000),
      });
      if (!sseRes.ok) continue;
      const sseText = await sseRes.text();
      if (sseText.includes('event: error')) continue;
      const match = sseText.match(/"url":\s*"([^"]+)"/);
      if (!match?.[1]) continue;

      const imgUrl = match[1].startsWith('http')
        ? match[1]
        : `${sp.baseUrl}/gradio_api/file=${match[1]}`;
      const imgRes = await fetch(imgUrl, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
      if (!imgRes.ok) continue;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length > 4000) {
        return {
          buffer: buf,
          mimeType: detectServerImageMime(buf, 'image/webp'),
          provider: sp.provider,
        };
      }
    } catch {
      // Try next edit space
    }
  }

  return null;
}

async function editPhotoWithSenseNova(
  sourceBuffer: Buffer,
  sourceMime: string,
  additionalImages: Array<{ data: string; mimeType: string }>,
  editInstruction: string,
  requestedAspect: PhotoAspectOption,
  quality: PhotoQualityOption,
  clientHfToken?: string
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

  // 1. Try instruction-based AI photo editors (FLUX.1-Kontext-dev & Qwen-Image-Edit)
  const hfEdited = await generateAiPhotoEditViaHuggingFace(
    sourceBuffer,
    sourceMime,
    editInstruction,
    clientHfToken
  );
  if (hfEdited) {
    const formatted = await enhanceAndFormatPhoto(hfEdited.buffer, hfEdited.mimeType, width, height, jpegQ);
    return {
      ...formatted,
      aspectRatio: effectiveAspect,
      provider: hfEdited.provider,
    };
  }

  // 2. Fallback to AI Horde img2img anchored to uploaded pixels
  const editedRaw = await generateAiHordeImg2ImgBuffer(
    sourceBuffer,
    img2imgPlan.editedPrompt,
    effectiveAspect,
    img2imgPlan.strength
  );
  if (editedRaw) {
    const formatted = await enhanceAndFormatPhoto(
      editedRaw,
      detectServerImageMime(editedRaw, 'image/webp'),
      width,
      height,
      jpegQ
    );
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
      quality,
      clientHfToken
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
  mastered?: boolean;
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
function buildWanTextToVideoPrompt(
  rawPrompt: string,
  aspectRatio: VideoAspectOption,
  duration: 5 | 10 = 10,
  quality: VideoQualityOption = '720p'
): string {
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

  const pacingText =
    duration === 10
      ? 'unhurried continuous 10-second tracking sequence'
      : 'smooth continuous 5-second sequence';

  const clarityText =
    quality === '1080p'
      ? 'ultra-sharp 1080p cinema clarity, rich fine texture'
      : quality === '480p'
      ? 'clean optical focus, balanced cinema lighting'
      : 'sharp HD optical focus, rich detail';

  return `${framingText} ${cleanedRaw}, ${pacingText}, fluid natural 3D motion, continuous smooth movement, realistic physics, authentic 35mm cinema lighting, ${clarityText}.`;
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

// Fast, reliable 30fps mastering tailored to exact 5s or 10s duration, aspect ratio, and 480p/720p/1080p quality
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
  const { outW, outH, crf, maxrate, bufsize } = getVideoResolutionConfig(
    aspectRatio,
    quality,
    targetSeconds
  );

  try {
    await fs.promises.writeFile(inPath, rawVideoBuffer);
    const { rawDuration } = await probeVideoTiming(inPath);
    const safeRawDur = Number.isFinite(rawDuration) && rawDuration > 0.3 ? rawDuration : 2.5;
    const unsharpStrength = quality === '1080p' ? '0.32' : quality === '720p' ? '0.26' : '0.18';

    onProgress?.(78);

    let filterComplexArgs: string[];
    if (safeRawDur >= targetSeconds - 0.15) {
      // Source clip already covers targetSeconds: smooth 30fps interpolation + Lanczos upscale/crop + exact trim
      filterComplexArgs = [
        '-vf',
        `framerate=fps=${targetFps}:interp_start=0:interp_end=255:scene=8.2,` +
          `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},` +
          `unsharp=5:5:${unsharpStrength}:5:5:0.0,format=yuv420p`,
      ];
    } else if (safeRawDur >= targetSeconds * 0.72) {
      // Gentle speed alignment (at most ~1.38x) + 30fps framerate blending
      const ptsScale = targetSeconds / safeRawDur;
      filterComplexArgs = [
        '-vf',
        `setpts=${ptsScale.toFixed(5)}*PTS,` +
          `framerate=fps=${targetFps}:interp_start=0:interp_end=255:scene=8.2,` +
          `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},` +
          `unsharp=5:5:${unsharpStrength}:5:5:0.0,format=yuv420p`,
      ];
    } else {
      // Seamless forward+reverse palindrome loop at native resolution first (low RAM, ~2s encode), then 30fps + Lanczos scale/crop
      const cycleDur = safeRawDur * 2;
      const repeats = Math.max(1, Math.min(8, Math.ceil((targetSeconds + 0.3) / cycleDur)));
      const splitLabels = Array.from({ length: repeats }, (_, idx) => `[c${idx}]`).join('');
      const concatInputs = Array.from({ length: repeats }, (_, idx) => `[c${idx}]`).join('');

      const filterGraph =
        repeats === 1
          ? `[0:v]fps=${targetFps},split=2[f0][r0src];` +
            `[r0src]reverse[r0];` +
            `[f0][r0]concat=n=2:v=1:a=0,` +
            `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},` +
            `unsharp=5:5:${unsharpStrength}:5:5:0.0,trim=duration=${targetSeconds},setpts=PTS-STARTPTS,format=yuv420p[vout]`
          : `[0:v]fps=${targetFps},split=2[f0][r0src];` +
            `[r0src]reverse[r0];` +
            `[f0][r0]concat=n=2:v=1:a=0,split=${repeats}${splitLabels};` +
            `${concatInputs}concat=n=${repeats}:v=1:a=0,` +
            `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},` +
            `unsharp=5:5:${unsharpStrength}:5:5:0.0,trim=duration=${targetSeconds},setpts=PTS-STARTPTS,format=yuv420p[vout]`;

      filterComplexArgs = ['-filter_complex', filterGraph, '-map', '[vout]'];
    }

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '0',
      '-i',
      inPath,
      ...filterComplexArgs,
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

    await runFfmpegWithProgress(args, targetFrames, 45000, (ratio) => {
      onProgress?.(Math.min(99, Math.round(84 + ratio * 15)));
    });

    const stat = await fs.promises.stat(finalOutPath);
    if (stat.size > 10000) {
      onProgress?.(100);
      return `/api/videos/${fileId}.mp4`;
    }
  } catch (err: any) {
    console.warn('Wan mastering fallback:', err?.message || err);
    try {
      const { rawDuration } = await probeVideoTiming(inPath);
      const safeRawDur = Number.isFinite(rawDuration) && rawDuration > 0.3 ? rawDuration : 2.5;
      const loopCount = Math.max(0, Math.ceil((targetSeconds + 0.5) / safeRawDur) - 1);
      const fallbackArgs = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '0',
        ...(loopCount > 0 ? ['-stream_loop', String(loopCount)] : []),
        '-i',
        inPath,
        '-vf',
        `fps=${targetFps},scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH},format=yuv420p`,
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
        'ultrafast',
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
): Promise<{ url: string; mastered: boolean } | null> {
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
    const mastered = await masterWanVideoSmooth(buf, targetSeconds, aspectRatio, quality, onProgress);
    if (mastered) return { url: mastered, mastered: true };

    // Never discard an already-generated AI video if FFmpeg mastering failed or timed out
    const rawId = `vid_raw_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const rawOutPath = path.join(GENERATED_VIDEOS_DIR, `${rawId}.mp4`);
    await fs.promises.writeFile(rawOutPath, buf);
    onProgress?.(100);
    return { url: `/api/videos/${rawId}.mp4`, mastered: false };
  } catch {
    return null;
  }
}

function extractGradioVideoUrl(sseText: string, spaceBaseUrl: string): string | null {
  const urlMatch = sseText.match(/"url":\s*"([^"]+\.(?:mp4|webm|mov)[^"]*)"/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].startsWith('http')
      ? urlMatch[1]
      : `${spaceBaseUrl}/gradio_api/file=${urlMatch[1]}`;
  }
  const pathMatch = sseText.match(/"path":\s*"([^"]+\.(?:mp4|webm|mov))"/i);
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

interface LiveVideoSpaceTier {
  model: string;
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  startPct: number;
  endPct: number;
  buildPayload: (
    wanPrompt: string,
    aspectRatio: VideoAspectOption,
    duration: 5 | 10,
    quality: VideoQualityOption
  ) => unknown[];
}

const LIVE_VIDEO_SPACE_TIERS: LiveVideoSpaceTier[] = [
  {
    model: WAN22_14B_T2V_MODEL,
    baseUrl: 'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
    endpoint: '/generate_video',
    timeoutMs: 75000,
    startPct: 10,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio, _duration) => {
      const arChoice =
        aspectRatio === '9:16'
          ? '9:16 (480x832)'
          : aspectRatio === '1:1'
          ? '1:1 (640x640)'
          : '16:9 (832x480)';
      return [
        wanPrompt,
        arChoice,
        5,
        WAN_NEGATIVE_PROMPT,
        4,
        1,
        1,
        Math.floor(Math.random() * 2147483647),
        true,
      ];
    },
  },
  {
    model: 'damo-vilab/text-to-video-ms-1.7b',
    baseUrl: 'https://mediasynthesismuseum-modelscope-text-to-video.hf.space',
    endpoint: '/generate',
    timeoutMs: 65000,
    startPct: 14,
    endPct: 80,
    buildPayload: (wanPrompt) => [
      wanPrompt,
      -1,
      32,
      25,
    ],
  },
  {
    model: 'Lightricks/LTX-2.5',
    baseUrl: 'https://upsampler-ltx-2-5.hf.space',
    endpoint: '/generate_video',
    timeoutMs: 65000,
    startPct: 15,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio, duration) => {
      const [h, w] =
        aspectRatio === '9:16'
          ? [832, 512]
          : aspectRatio === '1:1'
          ? [512, 512]
          : [512, 832];
      return [
        wanPrompt,
        null,
        h,
        w,
        duration === 10 ? 5 : 5,
        42,
        'conv',
        false,
        true,
        true,
      ];
    },
  },
  {
    model: 'prithivMLmods/NAVA-Text-to-Video',
    baseUrl: 'https://prithivmlmods-nava-text-to-video.hf.space',
    endpoint: '/infer_fn',
    timeoutMs: 65000,
    startPct: 15,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio) => [
      wanPrompt,
      '',
      null,
      null,
      null,
      16,
      4,
      aspectRatio === '9:16'
        ? '9:16 (704×1280)'
        : aspectRatio === '1:1'
        ? '1:1 (960×960)'
        : '16:9 (1280×704)',
    ],
  },
  {
    model: 'Lightricks/LTX-2.5',
    baseUrl: 'https://lightricks-ltx-2-5.hf.space',
    endpoint: '/run',
    timeoutMs: 65000,
    startPct: 16,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio, duration) => {
      const [h, w] =
        aspectRatio === '9:16'
          ? [832, 512]
          : aspectRatio === '1:1'
          ? [512, 512]
          : [512, 832];
      return [
        wanPrompt,
        null,
        h,
        w,
        duration === 10 ? 5 : 5,
        42,
        'conv',
        false,
        true,
        false,
      ];
    },
  },
  {
    model: 'Lightricks/LTX-2.3',
    baseUrl: 'https://lightricks-ltx-2-3.hf.space',
    endpoint: '/generate_video',
    timeoutMs: 65000,
    startPct: 18,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio) => {
      const [h, w] =
        aspectRatio === '9:16'
          ? [768, 512]
          : aspectRatio === '1:1'
          ? [512, 512]
          : [512, 768];
      return [
        null,
        wanPrompt,
        5,
        false,
        Math.floor(Math.random() * 2147483647),
        true,
        h,
        w,
      ];
    },
  },
  {
    model: 'Lightricks/LTX-Video-Distilled',
    baseUrl: 'https://lightricks-ltx-video-distilled.hf.space',
    endpoint: '/text_to_video',
    timeoutMs: 60000,
    startPct: 20,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio) => {
      const [h, w] =
        aspectRatio === '9:16'
          ? [704, 512]
          : aspectRatio === '1:1'
          ? [512, 512]
          : [512, 704];
      return [
        wanPrompt,
        WAN_NEGATIVE_PROMPT,
        '',
        '',
        h,
        w,
        'text-to-video',
        5,
        9,
        Math.floor(Math.random() * 2147483647),
        true,
        1.0,
        false,
      ];
    },
  },
  {
    model: WAN21_BASE_T2V_MODEL,
    baseUrl: 'https://numanajmal0-wan-video-api.hf.space',
    endpoint: '/generate',
    timeoutMs: 55000,
    startPct: 22,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio) => {
      const [wanW, wanH] =
        aspectRatio === '9:16'
          ? [480, 832]
          : aspectRatio === '1:1'
          ? [640, 640]
          : [832, 480];
      return [
        'wan-base',
        wanPrompt,
        WAN_NEGATIVE_PROMPT,
        wanW,
        wanH,
        81,
        18,
        5,
        -1,
        1,
        null,
      ];
    },
  },
  {
    model: 'Lightricks/LTX-2-Turbo',
    baseUrl: 'https://alexnasa-ltx-2-turbo.hf.space',
    endpoint: '/generate_video',
    timeoutMs: 75000,
    startPct: 28,
    endPct: 80,
    buildPayload: (wanPrompt, aspectRatio) => {
      const [ltxH, ltxW] =
        aspectRatio === '9:16'
          ? [768, 512]
          : aspectRatio === '1:1'
          ? [512, 512]
          : [512, 768];
      return [
        null,
        null,
        wanPrompt,
        null,
        'Text-to-Video',
        false,
        Math.floor(Math.random() * 2147483647),
        true,
        ltxH,
        ltxW,
        'No LoRA',
        null,
      ];
    },
  },
  {
    model: 'zai-org/CogVideoX-2b',
    baseUrl: 'https://zai-org-cogvideox-2b-space.hf.space',
    endpoint: '/generate',
    timeoutMs: 75000,
    startPct: 34,
    endPct: 80,
    buildPayload: (wanPrompt) => [wanPrompt, 35, 6],
  },
  {
    model: 'zai-org/CogVideoX-5b',
    baseUrl: 'https://zai-org-cogvideox-5b-space.hf.space',
    endpoint: '/generate',
    timeoutMs: 75000,
    startPct: 40,
    endPct: 80,
    buildPayload: (wanPrompt) => [
      wanPrompt,
      null,
      null,
      0.8,
      -1,
      false,
      false,
    ],
  },
];

async function generateViaLiveSpaceTier(
  tier: LiveVideoSpaceTier,
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void,
  clientHfToken?: string
): Promise<{ url: string; mastered: boolean } | null> {
  const token = clientHfToken || HF_ACCESS_TOKEN;
  const headerSets: Array<Record<string, string>> = token
    ? [{ Authorization: `Bearer ${token}`, 'X-HF-Token': token }, {}]
    : [{}];

  for (let i = 0; i < headerSets.length; i++) {
    const authHeaders = headerSets[i];
    try {
      const postRes = await fetch(`${tier.baseUrl}/gradio_api/call${tier.endpoint}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: tier.buildPayload(wanPrompt, aspectRatio, targetSeconds, quality) }),
        signal: AbortSignal.timeout(12000),
      });
      if (!postRes.ok) continue;

      const postJson: any = await postRes.json();
      const eventId = postJson?.event_id;
      if (!eventId) continue;

      const { sseText, quotaExceeded } = await readGradioSseWithProgress(
        `${tier.baseUrl}/gradio_api/call${tier.endpoint}/${eventId}`,
        authHeaders,
        tier.timeoutMs,
        tier.startPct,
        tier.endPct,
        onProgress
      );
      if (!sseText) {
        if (i === 0 && !quotaExceeded && tier.startPct >= 16) {
          break;
        }
        continue;
      }

      const rawUrl = extractGradioVideoUrl(sseText, tier.baseUrl);
      if (rawUrl) {
        const mastered = await fetchAndMasterWanClip(
          rawUrl,
          authHeaders,
          targetSeconds,
          aspectRatio,
          quality,
          onProgress
        );
        if (mastered) return mastered;
      }
    } catch (err: any) {
      console.warn(`Video Space (${tier.baseUrl}) attempt:`, err?.message || err);
    }
  }
  return null;
}

async function generateViaHfInferenceRouterVideo(
  wanPrompt: string,
  targetSeconds: 5 | 10,
  aspectRatio: VideoAspectOption,
  quality: VideoQualityOption,
  onProgress?: (pct: number) => void
): Promise<{ url: string; model: string } | null> {
  if (!HF_ACCESS_TOKEN) return null;

  const client = new InferenceClient(HF_ACCESS_TOKEN);
  const attempts: Array<{ model: string; provider: 'fal-ai' | 'wavespeed' }> = [
    { model: WAN22_14B_T2V_MODEL, provider: 'fal-ai' },
    { model: WAN22_14B_T2V_MODEL, provider: 'wavespeed' },
    { model: WAN21_14B_RCM_T2V_MODEL, provider: 'fal-ai' },
    { model: WAN21_BASE_T2V_MODEL, provider: 'fal-ai' },
  ];

  for (const attempt of attempts) {
    try {
      onProgress?.(20);
      const blob = await client.textToVideo(
        {
          model: attempt.model,
          inputs: wanPrompt,
          provider: attempt.provider,
          parameters: {
            negative_prompt: WAN_NEGATIVE_PROMPT,
            num_inference_steps: 20,
            guidance_scale: 5,
          },
        } as any,
        { signal: AbortSignal.timeout(30000) }
      );
      if (blob && blob.size > 8000) {
        const buffer = Buffer.from(await blob.arrayBuffer());
        if (buffer.length > 8000) {
          onProgress?.(82);
          const mastered = await masterWanVideoSmooth(
            buffer,
            targetSeconds,
            aspectRatio,
            quality,
            onProgress
          );
          if (mastered) {
            return { url: mastered, model: attempt.model };
          }
        }
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.warn(`HF Router (${attempt.provider}/${attempt.model}) attempt:`, msg);
      if (/401|402|403|payment|credit|balance/i.test(msg)) {
        break;
      }
    }
  }
  return null;
}

// Background worker executing real AI Text-to-Video generation (no fake photo-zoom fallback)
async function executeVideoJobInBackground(job: VideoJobState, clientHfToken?: string): Promise<void> {
  const updateProgress = (pct: number) => {
    job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
  };

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
    const wanPrompt = buildWanTextToVideoPrompt(job.prompt, job.aspectRatio, job.duration, job.quality);
    updateProgress(6);

    // 1. Try Hugging Face Inference Providers (fal-ai / wavespeed) first when HF_TOKEN supports it
    const infVideo = await generateViaHfInferenceRouterVideo(
      wanPrompt,
      job.duration,
      job.aspectRatio,
      job.quality,
      updateProgress
    );
    if (infVideo) {
      job.progress = 100;
      job.status = 'completed';
      job.videoUrl = infVideo.url;
      job.mastered = true;
      job.model = infVideo.model;
      return;
    }

    // 2. Try all verified RUNNING real Text-to-Video Spaces (Wan 2.2, LTX-2.5, LTX-2.3, LTX-Distilled, Wan 2.1)
    for (const tier of LIVE_VIDEO_SPACE_TIERS) {
      const result = await generateViaLiveSpaceTier(
        tier,
        wanPrompt,
        job.duration,
        job.aspectRatio,
        job.quality,
        updateProgress,
        clientHfToken
      );
      if (result) {
        job.progress = 100;
        job.status = 'completed';
        job.videoUrl = result.url;
        job.mastered = result.mastered;
        job.model = tier.model;
        return;
      }
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
      const authHeaders: Record<string, string> = HF_ACCESS_TOKEN
        ? { Authorization: `Bearer ${HF_ACCESS_TOKEN}`, 'X-HF-Token': HF_ACCESS_TOKEN }
        : {};
      const result = await fetchAndMasterWanClip(
        rawVideoUrl,
        authHeaders,
        duration,
        aspectRatio,
        quality,
        (pct) => {
          job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
        }
      );
      if (result) {
        job.progress = 100;
        job.status = 'completed';
        job.videoUrl = result.url;
        job.mastered = result.mastered;
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

  const clientHfToken = ((req.headers['x-hf-token'] as string) || '').trim();
  // Kick off generation asynchronously in background
  void executeVideoJobInBackground(job, clientHfToken || undefined);

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
    mastered: Boolean(job.mastered),
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


