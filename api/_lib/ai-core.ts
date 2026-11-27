import { GoogleGenAI } from '@google/genai';
import { InferenceClient } from '@huggingface/inference';

// ============================================================================
// Environment & Exact Model Configuration (All models preserved verbatim)
// ============================================================================

export function getXkiroApiKey(): string {
  return (process.env.XKIRO_API_KEY || '').trim();
}

export function getHfAccessToken(): string {
  return (process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '').trim();
}

export function getGeminiApiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

export const XKIRO_CHAT_URL = 'https://api.xkiro.com/v1/chat/completions';
export const XKIRO_MODELS_URL = 'https://api.xkiro.com/v1/models';

export const XKIRO_VISION_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
];

export const XKIRO_TEXT_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
];

export const XKIRO_PHOTO_MODELS = [
  'sensenova/sensenova-6.8-flash-lite',
];

export const HF_CHAT_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
export const HF_CHAT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'deepseek-ai/DeepSeek-R1',
  'meta-llama/Llama-3.1-8B-Instruct',
];
export const HF_VISION_MODELS = [
  'Qwen/Qwen3.8-Flash-Next',
  'google/gemma-4-26B-A4B-it',
  'Qwen/Qwen3.8-27B',
  'google/gemma-3-4b-it',
];
export const HF_DEFAULT_CHAT_MODEL = HF_CHAT_MODELS[0];

// Store expiration timestamp (blockedUntil ms) per model so 503/429 short-circuit cleanly
const xkiroUnavailableCache = new Map<string, number>();

export function markXkiroModelCooldown(model: string, status: number): void {
  const now = Date.now();
  if (status === 403 || status === 404) {
    xkiroUnavailableCache.set(model, now + 10 * 60 * 1000);
  } else if (status === 429 || status === 502 || status === 503 || status === 504) {
    xkiroUnavailableCache.set(model, now + 90 * 1000);
  }
}

export function isXkiroModelInCooldown(model: string, now: number = Date.now()): boolean {
  const blockedUntil = xkiroUnavailableCache.get(model);
  if (!blockedUntil) return false;
  if (now < blockedUntil) return true;
  xkiroUnavailableCache.delete(model);
  return false;
}

export async function getPrioritizedXkiroModels(hasImages: boolean): Promise<string[]> {
  return hasImages ? [...XKIRO_VISION_MODELS] : [...XKIRO_TEXT_MODELS];
}

export function extractTextFromChoiceContent(rawContent: any): string {
  if (typeof rawContent === 'string') return rawContent.trim();
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

// ============================================================================
// Transcription & Multi-Tier Chat
// ============================================================================

export async function transcribeAudioWithGemini(
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

  const geminiApiKey = getGeminiApiKey();
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
      } catch {
        // Try next Gemini model
      }
    }
  }

  const hfToken = clientHfToken || getHfAccessToken();
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
          } catch {
            // Try next ASR model
          }
        }
      }
    } catch {
      // Fall through to browser speech transcript hint
    }
  }

  return (transcriptHint || '').trim();
}

export async function callXkiroChat(
  payloadMessages: any[],
  hasImages: boolean
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const apiKey = getXkiroApiKey();
  if (!apiKey) return null;

  const modelsToTry = await getPrioritizedXkiroModels(hasImages);
  for (const model of modelsToTry) {
    try {
      const res = await fetch(XKIRO_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: payloadMessages,
          max_tokens: 900,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(14000),
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

export async function callHuggingFaceChat(
  payloadMessages: any[],
  clientToken?: string,
  hasImages: boolean = false
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const token = clientToken || getHfAccessToken();
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
        signal: AbortSignal.timeout(14000),
      });

      if (!res.ok) {
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
    } catch {
      // Fail over cleanly to next HF model
    }
  }

  return null;
}

export async function callGeminiFallbackChat(
  recentMessages: Array<{ role: string; content: string }>,
  attachments: any[]
): Promise<{ content: string; tokensUsed: number; modelUsed: string } | null> {
  const geminiApiKey = getGeminiApiKey();
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
    } catch {
      // Try next Gemini model
    }
  }
  return null;
}

export async function callZeroKeyFallbackChat(
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
  } catch {
    // Fall through to AI Horde (text-only only when no visual attachment is present)
  }

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
  } catch {
    // Return null cleanly
  }

  return null;
}

export async function handleChatRequest(params: {
  messages: any[];
  attachments?: any[];
  clientHfToken?: string;
}): Promise<
  | { status: 200; body: { content: string; voiceTranscript?: string; tokensUsed: number; provider: string } }
  | { status: 400 | 500 | 503; body: { error: string } }
> {
  const { messages, attachments, clientHfToken } = params;
  if (!messages || !Array.isArray(messages) || messages.length > 60) {
    return { status: 400, body: { error: 'Valid messages array is required' } };
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
    voiceTranscript = await transcribeAudioWithGemini(
      audioAtt.data,
      audioAtt.mimeType,
      clientHfToken,
      typeof audioAtt.transcriptHint === 'string' ? audioAtt.transcriptHint : undefined
    );
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

  // If raw audio wasn't transcribed or raw video was sent without image frames, let Gemini natively inspect the audio/video first
  if ((audioAtt && !voiceTranscript) || hasRawVideoOnly) {
    const geminiDirect = await callGeminiFallbackChat(recentMessages, safeAttachments);
    if (geminiDirect) {
      return {
        status: 200,
        body: {
          content: geminiDirect.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: geminiDirect.tokensUsed,
          provider: `Gemini (${geminiDirect.modelUsed})`,
        },
      };
    }
  }

  // Tier 1: Xkiro API (only when not blocked by untranscribed audio or unframed video)
  if (!hasRawVideoOnly && !(audioAtt && !voiceTranscript)) {
    const xkiroResult = await callXkiroChat(openAiMessages, hasImageParts);
    if (xkiroResult) {
      return {
        status: 200,
        body: {
          content: xkiroResult.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: xkiroResult.tokensUsed,
          provider: `Xkiro (${xkiroResult.modelUsed})`,
        },
      };
    }
  }

  // Tier 2: Hugging Face Router (Vision-Language models when images/frames attached)
  if (!hasRawVideoOnly) {
    const hfResult = await callHuggingFaceChat(openAiMessages, clientHfToken, hasImageParts);
    if (hfResult) {
      return {
        status: 200,
        body: {
          content: hfResult.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: hfResult.tokensUsed,
          provider: `HuggingFace (${hfResult.modelUsed})`,
        },
      };
    }
  }

  // Tier 3: Gemini Multimodal Fallback (supports text, images, video, and audio)
  const geminiResult = await callGeminiFallbackChat(recentMessages, safeAttachments);
  if (geminiResult) {
    return {
      status: 200,
      body: {
        content: geminiResult.content,
        voiceTranscript: voiceTranscript || undefined,
        tokensUsed: geminiResult.tokensUsed,
        provider: `Gemini (${geminiResult.modelUsed})`,
      },
    };
  }

  // Tier 4: Zero-key failover (Pollinations Vision/Text -> AI Horde text-only)
  if (!hasRawVideoOnly && !(audioAtt && !voiceTranscript)) {
    const zeroKeyResult = await callZeroKeyFallbackChat(plainMessages, openAiMessages, hasImageParts);
    if (zeroKeyResult) {
      return {
        status: 200,
        body: {
          content: zeroKeyResult.content,
          voiceTranscript: voiceTranscript || undefined,
          tokensUsed: zeroKeyResult.tokensUsed,
          provider: zeroKeyResult.modelUsed,
        },
      };
    }
  }

  const hint = audioAtt && !voiceTranscript
    ? 'Could not hear any speech in that voice recording. Please speak clearly and try again.'
    : hasVisualMedia
    ? 'Vision analysis servers are temporarily busy. Please try again in a moment.'
    : !getXkiroApiKey()
    ? 'Please configure XKIRO_API_KEY in Settings -> Secrets to enable Xkiro chat, or retry in a few moments.'
    : 'AI chat servers are temporarily busy. Please try again in a moment.';
  return { status: 503, body: { error: hint } };
}

// ============================================================================
// Photo Generation & Editing (Pure JS image probing + optional FFmpeg hooks)
// ============================================================================

export type PhotoAspectOption = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export type PhotoQualityOption = 'standard' | 'hd' | 'ultra';

export interface PhotoFilterPlan {
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

export interface PhotoImg2ImgPlan {
  mode: 'img2img';
  editedPrompt: string;
  strength: number;
  targetAspect?: PhotoAspectOption | null;
}

export type PhotoEditPlan = PhotoFilterPlan | PhotoImg2ImgPlan;

export interface PhotoBinaryHooks {
  enhancePhoto?: (
    inputBuffer: Buffer,
    fallbackMime: string,
    targetWidth: number,
    targetHeight: number,
    jpegQ: string
  ) => Promise<{ buffer: Buffer; mimeType: string }>;
  probeDimensions?: (imageBuffer: Buffer) => Promise<{ width: number; height: number } | null>;
  normalizeSourceBuffer?: (
    imageBuffer: Buffer,
    targetW: number,
    targetH: number,
    format?: 'jpeg' | 'png'
  ) => Promise<Buffer | null>;
  applyFilterPlan?: (
    sourceBuffer: Buffer,
    plan: PhotoFilterPlan,
    targetW: number,
    targetH: number,
    jpegQ: string
  ) => Promise<{ buffer: Buffer; mimeType: string } | null>;
}

export function normalizePhotoAspect(val: any): PhotoAspectOption {
  if (val === '16:9' || val === '9:16' || val === '4:3' || val === '3:4' || val === '1:1') {
    return val;
  }
  return '1:1';
}

export function normalizePhotoQuality(val: any): PhotoQualityOption {
  if (val === 'standard' || val === 'hd' || val === 'ultra') {
    return val;
  }
  return 'hd';
}

export function getPhotoDimensions(
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
  const clamp32 = (n: number) => Math.max(512, Math.min(1344, Math.round(n / 32) * 32));
  const scaleDown = Math.max(width, height) > 1344 ? 1344 / Math.max(width, height) : 1;
  const fluxWidth = clamp32(width * scaleDown);
  const fluxHeight = clamp32(height * scaleDown);
  const jpegQ = quality === 'ultra' ? '1' : quality === 'hd' ? '2' : '4';
  return { width, height, fluxWidth, fluxHeight, jpegQ };
}

export function detectImageMimeType(buf: Buffer, fallback: string = 'image/jpeg'): string {
  if (buf.length >= 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  }
  return fallback;
}

// Pure-JS header parser for PNG / WebP / GIF / JPEG dimensions (works with zero FFmpeg binaries)
export function parseImageDimensionsFast(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf.length < 24) return null;

    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // GIF
    if (buf.toString('ascii', 0, 4) === 'GIF8') {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunkHeader = buf.toString('ascii', 12, 16);
      if (chunkHeader === 'VP8X' && buf.length >= 30) {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (chunkHeader === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (chunkHeader === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
    }

    // JPEG SOF0..SOF3 scanning
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 8 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const segLen = buf.readUInt16BE(offset + 2);
        if (
          marker === 0xc0 ||
          marker === 0xc1 ||
          marker === 0xc2 ||
          marker === 0xc3
        ) {
          if (offset + 8 < buf.length) {
            const height = buf.readUInt16BE(offset + 5);
            const width = buf.readUInt16BE(offset + 7);
            return width > 0 && height > 0 ? { width, height } : null;
          }
        }
        if (segLen < 2) break;
        offset += 2 + segLen;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function pickClosestPhotoAspect(w: number, h: number): PhotoAspectOption {
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

export function sanitizePromptForRealism(rawPrompt: string): string {
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

export function cleanCompiledCameraPrompt(rawText: string): string | null {
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

export async function compileStrictRealisticPrompt(
  rawPrompt: string,
  clientToken?: string
): Promise<{ compiledPrompt: string; directImageUri?: string }> {
  const compilerSystem =
    'You are a strict camera-realism prompt compiler. Convert the user request into ONE concise English description (35-60 words) for an authentic real-world DSLR photograph starting with: Unedited RAW 35mm DSLR photograph of';

  const xkiroKey = getXkiroApiKey();
  if (xkiroKey) {
    const deadline = Date.now() + 2400;
    const now = Date.now();
    const activePhotoModels = XKIRO_PHOTO_MODELS.filter((m) => !isXkiroModelInCooldown(m, now));
    const modelsToTry = activePhotoModels.length > 0 ? activePhotoModels : XKIRO_PHOTO_MODELS;

    for (const model of modelsToTry) {
      const remaining = deadline - Date.now();
      if (remaining < 600) break;
      try {
        const xRes = await fetch(XKIRO_CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${xkiroKey}`,
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
          signal: AbortSignal.timeout(Math.min(2000, remaining)),
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

  try {
    const token = clientToken || getHfAccessToken();
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

export const REAL_CAMERA_STYLE_SUFFIX =
  'Captured on Sony A7R V 50mm f/1.8 lens, ISO 400, real candid documentary photography, authentic natural skin pores and subtle imperfections, real fabric weave, subtle 35mm film grain, natural ambient lighting';

export async function generateGradioFluxPhotoBuffer(
  spaceBaseUrl: string,
  dataPayload: any[],
  timeoutMs: number = 12000,
  endpointPath: string = '/infer',
  clientToken?: string
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = clientToken || getHfAccessToken();
  const activeHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
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

export async function generateHuggingFaceInferencePhoto(
  promptText: string,
  width: number,
  height: number,
  clientToken?: string
): Promise<Buffer | null> {
  const token = clientToken || getHfAccessToken();
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

export async function generateAiHordePhotoBuffer(
  fullPrompt: string,
  aspectRatio: PhotoAspectOption,
  maxWaitMs: number = 35000
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
    // Use default curated models
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
    const deadline = Date.now() + maxWaitMs;
    let submitRes = await submitJob(hordeW, hordeH, 16, hordeModels);
    if (submitRes.status === 403) {
      submitRes = await submitJob(512, 512, 12, ['Deliberate', 'Realistic Vision', 'stable_diffusion']);
    }

    if (!submitRes.ok) return null;
    const submitJson: any = await submitRes.json();
    const jobId = submitJson?.id;
    if (!jobId) return null;

    while (Date.now() < deadline) {
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
            return buf.length > 5000 ? buf : null;
          }
          const rawB64 = imgRef.includes(',') ? imgRef.split(',')[1] : imgRef;
          const buf = Buffer.from(rawB64, 'base64');
          return buf.length > 5000 ? buf : null;
        }
      } catch {
        // Ignore transient poll error
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function submitAiHordePhotoJob(
  fullPrompt: string,
  aspectRatio: PhotoAspectOption
): Promise<string | null> {
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

  const hordeModels = [
    'Deliberate',
    'Realistic Vision',
    "ICBINP - I Can't Believe It's Not Photography",
    'Edge Of Realism',
    'majicMIX realistic',
    'stable_diffusion',
  ];

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
      signal: AbortSignal.timeout(4500),
    });

  try {
    let submitRes = await submitJob(hordeW, hordeH, 16, hordeModels);
    if (submitRes.status === 403 || submitRes.status === 400) {
      submitRes = await submitJob(512, 512, 12, ['Deliberate', 'Realistic Vision', 'stable_diffusion']);
    }
    if (!submitRes.ok) return null;
    const submitJson: any = await submitRes.json();
    return typeof submitJson?.id === 'string' && submitJson.id ? submitJson.id : null;
  } catch {
    return null;
  }
}

export async function generateReliablePhoto(
  compiledScenePrompt: string,
  aspectRatio: PhotoAspectOption,
  quality: PhotoQualityOption,
  clientToken?: string,
  hooks?: PhotoBinaryHooks
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
  const hasXkiro = Boolean(getXkiroApiKey());
  const isServerlessFast = !hooks?.enhancePhoto;

  const finalize = async (buf: Buffer, fallbackMime: string, provider: string) => {
    const detected = detectImageMimeType(buf, fallbackMime);
    if (hooks?.enhancePhoto) {
      const enhanced = await hooks.enhancePhoto(buf, detected, width, height, jpegQ);
      return { ...enhanced, provider };
    }
    return { buffer: buf, mimeType: detected, provider };
  };

  // Race HF Inference + FLUX.1-schnell + Z-Image-Turbo cleanly within serverless timeout
  try {
    const fastWinner = await Promise.any([
      generateHuggingFaceInferencePhoto(fullPrompt, fluxWidth, fluxHeight, clientToken).then((buf) => {
        if (!buf) throw new Error('hf-inference-empty');
        return {
          buf,
          mime: 'image/jpeg',
          provider: hasXkiro ? 'Xkiro-SenseNova-FLUX' : 'HuggingFace-FLUX.1-schnell',
        };
      }),
      generateGradioFluxPhotoBuffer(
        'https://black-forest-labs-flux-1-schnell.hf.space',
        [fullPrompt, seed, true, fluxWidth, fluxHeight, fluxSteps],
        isServerlessFast ? 5200 : 12000,
        '/infer',
        clientToken
      ).then((buf) => {
        if (!buf) throw new Error('flux-space-empty');
        return {
          buf,
          mime: 'image/webp',
          provider: hasXkiro ? 'Xkiro-SenseNova-FLUX' : 'FLUX.1-schnell',
        };
      }),
      generateGradioFluxPhotoBuffer(
        'https://tongyi-mai-z-image-turbo.hf.space',
        [fullPrompt, fluxWidth, fluxHeight, 9, seed, true],
        isServerlessFast ? 5200 : 9500,
        '/generate',
        clientToken
      ).then((buf) => {
        if (!buf) throw new Error('zimage-empty');
        return {
          buf,
          mime: 'image/webp',
          provider: hasXkiro ? 'Xkiro-SenseNova-ZImage' : 'Z-Image-Turbo',
        };
      }),
    ]);
    return await finalize(fastWinner.buf, fastWinner.mime, fastWinner.provider);
  } catch {
    if (isServerlessFast) {
      // On serverless without local FFmpeg, avoid blocking 32s on AI Horde polling; return null so handler sends pendingHorde immediately
      return null;
    }
  }

  // Long-running Node server fallback: AI Horde polling
  const hordeBuf = await generateAiHordePhotoBuffer(`${compiledScenePrompt}, ${framingHint}`, aspectRatio, 32000);
  if (hordeBuf) {
    return await finalize(
      hordeBuf,
      'image/webp',
      hasXkiro ? 'Xkiro-SenseNova-SDXL' : 'SDXL-Photo'
    );
  }
  return null;
}

export function buildFallbackPhotoEditPlan(editInstruction: string): PhotoEditPlan {
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

export async function planPhotoEditWithXkiro(
  sourceDataUrl: string,
  additionalDataUrls: string[],
  editInstruction: string
): Promise<PhotoEditPlan> {
  if (!getXkiroApiKey()) {
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
  } catch {
    // Fall back to rule-based edit planner
  }

  return buildFallbackPhotoEditPlan(editInstruction);
}

export async function generateAiHordeImg2ImgBuffer(
  sourceBuffer: Buffer,
  editedPrompt: string,
  aspectRatio: PhotoAspectOption,
  denoisingStrength: number,
  hooks?: PhotoBinaryHooks,
  maxWaitMs: number = 38000
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

  // Try FFmpeg normalization if available (Node/Docker), otherwise fall back directly to sourceBuffer (Vercel!)
  const normalized = hooks?.normalizeSourceBuffer
    ? await hooks.normalizeSourceBuffer(sourceBuffer, hordeW, hordeH, 'png')
    : null;
  const primarySource = normalized || sourceBuffer;

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
  } catch {
    // Keep curated list
  }

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
    const deadline = Date.now() + maxWaitMs;
    let submitRes = await submitImg2Img(primarySource, hordeW, hordeH, 16, hordeModels);
    if (submitRes.status === 403 || submitRes.status === 400) {
      const squareFallback =
        hooks?.normalizeSourceBuffer && (hordeW !== 512 || hordeH !== 512)
          ? (await hooks.normalizeSourceBuffer(sourceBuffer, 512, 512, 'png')) || sourceBuffer
          : sourceBuffer;
      submitRes = await submitImg2Img(
        squareFallback,
        512,
        512,
        12,
        ['Deliberate', 'Realistic Vision', 'stable_diffusion']
      );
    }

    if (!submitRes.ok) {
      return null;
    }

    const submitJson: any = await submitRes.json();
    const jobId = submitJson?.id;
    if (!jobId) return null;

    while (Date.now() < deadline) {
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
      } catch {
        // Continue polling
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function generateAiPhotoEditViaHuggingFace(
  sourceBuffer: Buffer,
  sourceMime: string,
  editInstruction: string,
  clientHfToken?: string
): Promise<{ buffer: Buffer; mimeType: string; provider: string } | null> {
  const token = clientHfToken || getHfAccessToken();
  if (!token) return null;

  // 1. Try Hugging Face Inference Providers (FLUX.1-Kontext-dev & Qwen-Image-Edit)
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
              mimeType: detectImageMimeType(buf, 'image/jpeg'),
              provider: `HuggingFace-${item.model.split('/').pop()}`,
            };
          }
        }
      } catch (err: any) {
        if (/401|402|403|payment|credit|balance/i.test(String(err?.message || err))) break;
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
        signal: AbortSignal.timeout(18000),
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
          mimeType: detectImageMimeType(buf, 'image/webp'),
          provider: sp.provider,
        };
      }
    } catch {
      // Try next edit space
    }
  }

  return null;
}

export async function editPhotoWithSenseNova(
  sourceBuffer: Buffer,
  sourceMime: string,
  additionalImages: Array<{ data: string; mimeType: string }>,
  editInstruction: string,
  requestedAspect: PhotoAspectOption,
  quality: PhotoQualityOption,
  hooks?: PhotoBinaryHooks,
  clientHfToken?: string
): Promise<{ buffer: Buffer; mimeType: string; aspectRatio: PhotoAspectOption; provider: string } | null> {
  const fastDims = parseImageDimensionsFast(sourceBuffer);
  const dims = fastDims || (hooks?.probeDimensions ? await hooks.probeDimensions(sourceBuffer) : null);
  const naturalAspect = dims ? pickClosestPhotoAspect(dims.width, dims.height) : requestedAspect;

  const sourceDataUrl = `data:${sourceMime};base64,${sourceBuffer.toString('base64')}`;
  const additionalDataUrls = additionalImages.map((img) => `data:${img.mimeType};base64,${img.data}`);

  const plan = await planPhotoEditWithXkiro(sourceDataUrl, additionalDataUrls, editInstruction);
  const hasXkiro = Boolean(getXkiroApiKey());

  if (plan.mode === 'filter' && hooks?.applyFilterPlan) {
    let effectiveAspect = plan.cropAspect || naturalAspect;
    if (plan.rotate === 90 || plan.rotate === 270) {
      if (effectiveAspect === '16:9') effectiveAspect = '9:16';
      else if (effectiveAspect === '9:16') effectiveAspect = '16:9';
      else if (effectiveAspect === '4:3') effectiveAspect = '3:4';
      else if (effectiveAspect === '3:4') effectiveAspect = '4:3';
    }
    const { width, height, jpegQ } = getPhotoDimensions(effectiveAspect, quality);
    const filtered = await hooks.applyFilterPlan(sourceBuffer, plan, width, height, jpegQ);
    if (filtered) {
      return {
        ...filtered,
        aspectRatio: effectiveAspect,
        provider: hasXkiro ? 'Xkiro-SenseNova-Editor' : 'BloopX-Photo-Editor',
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

  // 1. Try instruction-based AI image editors (FLUX.1-Kontext-dev / Qwen-Image-Edit)
  const hfEdited = await generateAiPhotoEditViaHuggingFace(
    sourceBuffer,
    sourceMime,
    editInstruction,
    clientHfToken
  );
  if (hfEdited) {
    const formatted = hooks?.enhancePhoto
      ? await hooks.enhancePhoto(hfEdited.buffer, hfEdited.mimeType, width, height, jpegQ)
      : { buffer: hfEdited.buffer, mimeType: hfEdited.mimeType };
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
    img2imgPlan.strength,
    hooks
  );
  if (editedRaw) {
    const detected = detectImageMimeType(editedRaw, 'image/webp');
    const formatted = hooks?.enhancePhoto
      ? await hooks.enhancePhoto(editedRaw, detected, width, height, jpegQ)
      : { buffer: editedRaw, mimeType: detected };
    return {
      ...formatted,
      aspectRatio: effectiveAspect,
      provider: hasXkiro ? 'Xkiro-SenseNova-Edit-SDXL' : 'Photo-Edit-Img2Img',
    };
  }

  return null;
}

export async function submitAiHordeImg2ImgJob(
  sourceBuffer: Buffer,
  editedPrompt: string,
  aspectRatio: PhotoAspectOption,
  denoisingStrength: number
): Promise<string | null> {
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

  const hordeModels = [
    'Deliberate',
    'Realistic Vision',
    "ICBINP - I Can't Believe It's Not Photography",
    'Edge Of Realism',
    'majicMIX realistic',
    'stable_diffusion',
  ];

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
      signal: AbortSignal.timeout(5000),
    });

  try {
    let submitRes = await submitImg2Img(sourceBuffer, hordeW, hordeH, 16, hordeModels);
    if (submitRes.status === 403 || submitRes.status === 400) {
      submitRes = await submitImg2Img(sourceBuffer, 512, 512, 12, ['Deliberate', 'Realistic Vision', 'stable_diffusion']);
    }
    if (!submitRes.ok) return null;
    const submitJson: any = await submitRes.json();
    return typeof submitJson?.id === 'string' && submitJson.id ? submitJson.id : null;
  } catch {
    return null;
  }
}

export async function handleGenerateImageRequest(
  body: any,
  clientHfToken?: string,
  hooks?: PhotoBinaryHooks
): Promise<{ status: number; body: any }> {
  const {
    prompt,
    aspectRatio: rawAspect,
    quality: rawQuality,
    sourceImage,
    additionalImages,
  } = body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { status: 400, body: { error: 'prompt is required' } };
  }

  const cleanPrompt = prompt.trim().slice(0, 1200);
  const aspectRatio = normalizePhotoAspect(rawAspect);
  const quality = normalizePhotoQuality(rawQuality);
  const hasXkiro = Boolean(getXkiroApiKey());

  if (sourceImage && typeof sourceImage.data === 'string' && sourceImage.data.length > 0) {
    if (sourceImage.data.length > 25_000_000) {
      return {
        status: 400,
        body: { error: 'Uploaded image is too large. Please use an image under 15MB.' },
      };
    }
    const rawMime = typeof sourceImage.mimeType === 'string' ? sourceImage.mimeType : 'image/jpeg';
    if (!rawMime.startsWith('image/')) {
      return { status: 400, body: { error: 'Invalid source image MIME type.' } };
    }
    const cleanB64 = sourceImage.data.includes(',') ? sourceImage.data.split(',')[1] : sourceImage.data;
    const sourceBuffer = Buffer.from(cleanB64, 'base64');
    if (sourceBuffer.length < 100) {
      return { status: 400, body: { error: 'Invalid uploaded image data.' } };
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

    // Serverless fast path (no FFmpeg): plan via Xkiro Vision and try fast HF instruction editor or return filterPlan / async Horde jobId
    if (!hooks?.enhancePhoto) {
      const fastDims = parseImageDimensionsFast(sourceBuffer);
      const naturalAspect = fastDims ? pickClosestPhotoAspect(fastDims.width, fastDims.height) : aspectRatio;
      const sourceDataUrl = `data:${rawMime};base64,${sourceBuffer.toString('base64')}`;
      const additionalDataUrls = safeExtras.map((img: { data: string; mimeType: string }) => `data:${img.mimeType};base64,${img.data}`);
      const plan = await planPhotoEditWithXkiro(sourceDataUrl, additionalDataUrls, cleanPrompt);

      if (plan.mode === 'filter') {
        let effectiveAspect = plan.cropAspect || naturalAspect;
        if (plan.rotate === 90 || plan.rotate === 270) {
          effectiveAspect =
            effectiveAspect === '16:9'
              ? '9:16'
              : effectiveAspect === '9:16'
              ? '16:9'
              : effectiveAspect === '4:3'
              ? '3:4'
              : effectiveAspect === '3:4'
              ? '4:3'
              : '1:1';
        }
        return {
          status: 200,
          body: {
            imageUrl: null,
            filterPlan: plan,
            aspectRatio: effectiveAspect,
            quality,
            edited: true,
            provider: hasXkiro ? 'Xkiro-SenseNova-Editor' : 'BloopX-Photo-Editor',
          },
        };
      }

      const effectiveAspect = plan.targetAspect || naturalAspect;
      const hfEdited = await generateAiPhotoEditViaHuggingFace(
        sourceBuffer,
        rawMime,
        cleanPrompt,
        clientHfToken
      );
      if (hfEdited) {
        return {
          status: 200,
          body: {
            imageUrl: `data:${hfEdited.mimeType};base64,${hfEdited.buffer.toString('base64')}`,
            prompt: cleanPrompt,
            aspectRatio: effectiveAspect,
            quality,
            edited: true,
            provider: hfEdited.provider,
          },
        };
      }

      const hordeJobId = await submitAiHordeImg2ImgJob(
        sourceBuffer,
        plan.editedPrompt,
        effectiveAspect,
        plan.strength
      );
      if (hordeJobId) {
        return {
          status: 200,
          body: {
            imageUrl: null,
            pendingHorde: true,
            hordeJobId,
            editedPrompt: plan.editedPrompt,
            aspectRatio: effectiveAspect,
            quality,
            edited: true,
            provider: hasXkiro ? 'Xkiro-SenseNova-Edit-SDXL' : 'Photo-Edit-Img2Img',
          },
        };
      }
      return {
        status: 200,
        body: {
          imageUrl: null,
          editedPrompt: plan.editedPrompt,
          aspectRatio: effectiveAspect,
          quality,
          edited: true,
          cooldown: true,
        },
      };
    }

    const edited = await editPhotoWithSenseNova(
      sourceBuffer,
      rawMime,
      safeExtras,
      cleanPrompt,
      aspectRatio,
      quality,
      hooks,
      clientHfToken
    );
    if (edited) {
      const b64 = edited.buffer.toString('base64');
      return {
        status: 200,
        body: {
          imageUrl: `data:${edited.mimeType};base64,${b64}`,
          prompt: cleanPrompt,
          aspectRatio: edited.aspectRatio,
          quality,
          edited: true,
          provider: edited.provider,
        },
      };
    }

    return {
      status: 200,
      body: {
        imageUrl: null,
        cooldown: true,
      },
    };
  }

  const { compiledPrompt, directImageUri } = await compileStrictRealisticPrompt(
    cleanPrompt,
    clientHfToken
  );
  if (directImageUri) {
    return {
      status: 200,
      body: {
        imageUrl: directImageUri,
        prompt: cleanPrompt,
        aspectRatio,
        quality,
        provider: 'Xkiro-Photo',
      },
    };
  }

  const rendered = await generateReliablePhoto(
    compiledPrompt,
    aspectRatio,
    quality,
    clientHfToken,
    hooks
  );
  if (rendered) {
    const b64 = rendered.buffer.toString('base64');
    return {
      status: 200,
      body: {
        imageUrl: `data:${rendered.mimeType};base64,${b64}`,
        prompt: cleanPrompt,
        aspectRatio,
        quality,
        provider: rendered.provider,
      },
    };
  }

  // Serverless fast handoff: submit async AI Horde job (<1s) so browser completes polling without Vercel 10s/60s timeout
  if (!hooks?.enhancePhoto) {
    const framingHint =
      aspectRatio === '16:9' || aspectRatio === '4:3'
        ? 'wide horizontal composition'
        : aspectRatio === '9:16' || aspectRatio === '3:4'
        ? 'vertical portrait framing'
        : 'balanced square framing';
    const hordeJobId = await submitAiHordePhotoJob(`${compiledPrompt}, ${framingHint}`, aspectRatio);
    return {
      status: 200,
      body: {
        imageUrl: null,
        compiledPrompt,
        aspectRatio,
        quality,
        ...(hordeJobId ? { pendingHorde: true, hordeJobId } : { cooldown: true }),
      },
    };
  }

  return {
    status: 200,
    body: {
      imageUrl: null,
      compiledPrompt,
      cooldown: true,
    },
  };
}

// ============================================================================
// Pure Wan Text-to-Video Models & Stateless Vercel Multi-Tier Orchestration
// ============================================================================

export type VideoAspectOption = '16:9' | '9:16' | '1:1';
export type VideoQualityOption = '480p' | '720p' | '1080p';

export const WAN22_14B_T2V_MODEL = 'Wan-AI/Wan2.2-T2V-A14B';
export const WAN22_5B_T2V_MODEL = 'Wan-AI/Wan2.2-TI2V-5B';
export const WAN21_14B_RCM_T2V_MODEL = 'Wan-AI/Wan2.1-T2V-14B';
export const WAN21_BASE_T2V_MODEL = 'Wan-AI/Wan2.1-T2V-1.3B';

export const WAN_NEGATIVE_PROMPT =
  '色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走, camera zoom, ken burns effect, watermark, text, signature';

export function normalizeVideoDuration(val: any): 5 | 10 {
  return Number(val) === 5 ? 5 : 10;
}

export function normalizeVideoAspect(val: any): VideoAspectOption {
  if (val === '16:9' || val === '9:16' || val === '1:1') return val;
  return '16:9';
}

export function normalizeVideoQuality(val: any): VideoQualityOption {
  if (val === '480p' || val === '720p' || val === '1080p') return val;
  return '720p';
}

export function buildWanTextToVideoPrompt(
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

export function extractGradioVideoUrl(sseText: string, spaceBaseUrl: string): string | null {
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

export interface WanSpaceTierSpec {
  model: string;
  baseUrl: string;
  endpoint: string;
  startPct: number;
  endPct: number;
  buildPayload: (
    wanPrompt: string,
    aspectRatio: VideoAspectOption,
    duration: 5 | 10,
    quality: VideoQualityOption
  ) => unknown[];
}

export async function generateViaGeminiVeoVideo(
  wanPrompt: string,
  aspectRatio: VideoAspectOption,
  duration: 5 | 10
): Promise<{ buffer: Buffer; model: string } | null> {
  const geminiKey = getGeminiApiKey();
  if (!geminiKey) return null;

  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const veoAspect = aspectRatio === '9:16' ? '9:16' : '16:9';
  const veoDuration = duration === 5 ? 5 : 8;

  for (const model of ['veo-3.0-fast-generate-001', 'veo-2.0-generate-001']) {
    try {
      let operation = await ai.models.generateVideos({
        model,
        source: { prompt: wanPrompt },
        config: {
          numberOfVideos: 1,
          aspectRatio: veoAspect,
          durationSeconds: veoDuration,
        },
      });

      const deadline = Date.now() + 40000;
      while (!operation.done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3500));
        operation = await ai.operations.getVideosOperation({ operation });
      }

      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (videoUri) {
        const res = await fetch(videoUri, {
          headers: { 'x-goog-api-key': geminiKey },
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 8000) {
            return { buffer: buf, model };
          }
        }
      }
    } catch (err: any) {
      if (/401|403|404|not found|permission|quota/i.test(String(err?.message || err))) {
        continue;
      }
    }
  }
  return null;
}

export async function generateViaHfInferenceRouterVideo(
  wanPrompt: string
): Promise<{ buffer: Buffer; model: string } | null> {
  const token = getHfAccessToken();
  if (!token) return null;

  const client = new InferenceClient(token);
  const attempts: Array<{ model: string; provider: 'fal-ai' | 'wavespeed' | 'replicate' | 'hf-inference' }> = [
    { model: WAN22_14B_T2V_MODEL, provider: 'fal-ai' },
    { model: WAN22_14B_T2V_MODEL, provider: 'wavespeed' },
    { model: WAN22_14B_T2V_MODEL, provider: 'replicate' },
    { model: WAN21_14B_RCM_T2V_MODEL, provider: 'fal-ai' },
    { model: WAN21_BASE_T2V_MODEL, provider: 'fal-ai' },
    { model: WAN21_BASE_T2V_MODEL, provider: 'hf-inference' },
  ];

  for (const attempt of attempts) {
    try {
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
          return { buffer, model: attempt.model };
        }
      }
    } catch (err: any) {
      if (/401|402|403|payment|credit|balance/i.test(String(err?.message || err))) break;
    }
  }
  return null;
}

export const WAN_SPACE_TIERS: WanSpaceTierSpec[] = [
  {
    model: 'damo-vilab/text-to-video-ms-1.7b',
    baseUrl: 'https://mediasynthesismuseum-modelscope-text-to-video.hf.space',
    endpoint: '/generate',
    startPct: 12,
    endPct: 92,
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
    startPct: 15,
    endPct: 92,
    buildPayload: (wanPrompt, aspectRatio) => {
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
        5,
        42,
        'conv',
        false,
        true,
        true,
      ];
    },
  },
  {
    model: WAN22_14B_T2V_MODEL,
    baseUrl: 'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
    endpoint: '/generate_video',
    startPct: 18,
    endPct: 92,
    buildPayload: (wanPrompt, aspectRatio) => {
      const arChoice =
        aspectRatio === '9:16'
          ? '9:16 (480x832)'
          : aspectRatio === '1:1'
          ? '1:1 (640x640)'
          : '16:9 (832x480)';
      return [
        wanPrompt,
        arChoice,
        4,
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
    model: 'prithivMLmods/NAVA-Text-to-Video',
    baseUrl: 'https://prithivmlmods-nava-text-to-video.hf.space',
    endpoint: '/infer_fn',
    startPct: 20,
    endPct: 92,
    buildPayload: (wanPrompt, aspectRatio) => [
      wanPrompt,
      '',
      null,
      null,
      null,
      16,
      5,
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
    startPct: 22,
    endPct: 92,
    buildPayload: (wanPrompt, aspectRatio) => {
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
        5,
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
    startPct: 24,
    endPct: 92,
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
    startPct: 26,
    endPct: 92,
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
    startPct: 28,
    endPct: 92,
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
    startPct: 30,
    endPct: 92,
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
    startPct: 34,
    endPct: 92,
    buildPayload: (wanPrompt) => [wanPrompt, 35, 6],
  },
  {
    model: 'zai-org/CogVideoX-5b',
    baseUrl: 'https://zai-org-cogvideox-5b-space.hf.space',
    endpoint: '/generate',
    startPct: 40,
    endPct: 92,
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

export interface StatelessVideoState {
  v: 1;
  p: string;
  d: 5 | 10;
  a: VideoAspectOption;
  q: VideoQualityOption;
  t: number;
  e: string;
  st: number;
  pr: number;
  qc?: number;
}

export function encodeStatelessVideoJob(state: StatelessVideoState): string {
  const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `vstat_${b64}`;
}

export function decodeStatelessVideoJob(jobId: string): StatelessVideoState | null {
  if (!jobId || typeof jobId !== 'string' || !jobId.startsWith('vstat_') || jobId.length > 2048) {
    return null;
  }
  try {
    const raw = Buffer.from(jobId.slice(6), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed?.v !== 1 ||
      typeof parsed.p !== 'string' ||
      !parsed.p.trim() ||
      typeof parsed.t !== 'number' ||
      parsed.t < 0 ||
      parsed.t >= WAN_SPACE_TIERS.length ||
      typeof parsed.e !== 'string' ||
      !/^[a-zA-Z0-9._-]{3,120}$/.test(parsed.e)
    ) {
      return null;
    }
    return {
      v: 1,
      p: parsed.p.slice(0, 500),
      d: normalizeVideoDuration(parsed.d),
      a: normalizeVideoAspect(parsed.a),
      q: normalizeVideoQuality(parsed.q),
      t: parsed.t,
      e: parsed.e,
      st: typeof parsed.st === 'number' ? parsed.st : Date.now(),
      pr: typeof parsed.pr === 'number' ? parsed.pr : 8,
      qc: typeof parsed.qc === 'number' ? parsed.qc : 0,
    };
  } catch {
    return null;
  }
}

export async function submitWanSpaceTier(
  tierIdx: number,
  cleanPrompt: string,
  aspectRatio: VideoAspectOption,
  duration: 5 | 10 = 10,
  quality: VideoQualityOption = '720p'
): Promise<{ eventId: string | null; quotaExceeded: boolean; anonymous?: boolean }> {
  const tier = WAN_SPACE_TIERS[tierIdx];
  if (!tier) return { eventId: null, quotaExceeded: false };

  const token = getHfAccessToken();
  const headerSets: Array<{ headers: Record<string, string>; anonymous: boolean }> = token
    ? [
        { headers: { Authorization: `Bearer ${token}`, 'X-HF-Token': token }, anonymous: false },
        { headers: {}, anonymous: true },
      ]
    : [{ headers: {}, anonymous: true }];
  const wanPrompt = buildWanTextToVideoPrompt(cleanPrompt, aspectRatio, duration, quality);

  let sawQuota = false;
  for (const item of headerSets) {
    try {
      const postRes = await fetch(`${tier.baseUrl}/gradio_api/call${tier.endpoint}`, {
        method: 'POST',
        headers: { ...item.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: tier.buildPayload(wanPrompt, aspectRatio, duration, quality) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!postRes.ok) {
        const errBody = await postRes.text().catch(() => '');
        if (/ZeroGPU quota|exceeded your.*quota/i.test(errBody)) sawQuota = true;
        continue;
      }
      const postJson: any = await postRes.json();
      const eventId = typeof postJson?.event_id === 'string' ? postJson.event_id.trim() : '';
      if (eventId && /^[a-zA-Z0-9._-]{3,120}$/.test(eventId)) {
        return { eventId, quotaExceeded: false, anonymous: item.anonymous };
      }
    } catch {
      // Try anonymous fallback or next tier
    }
  }
  return { eventId: null, quotaExceeded: sawQuota };
}

export async function startStatelessVideoJob(body: any): Promise<{ status: number; body: any }> {
  const { prompt, duration: rawDuration, aspectRatio: rawAspect, quality: rawQuality } = body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { status: 400, body: { error: 'prompt is required' } };
  }

  const cleanPrompt = prompt.trim().slice(0, 500);
  const duration = normalizeVideoDuration(rawDuration);
  const aspectRatio = normalizeVideoAspect(rawAspect);
  const quality = normalizeVideoQuality(rawQuality);
  const startedAt = Date.now();
  const compiledPrompt = buildWanTextToVideoPrompt(cleanPrompt, aspectRatio, duration, quality);

  // 1. Authenticated provider routes first when server API keys are configured (never hit ZeroGPU IP limits)
  if (getHfAccessToken()) {
    const infVideo = await generateViaHfInferenceRouterVideo(compiledPrompt);
    if (infVideo && infVideo.buffer.length <= 4 * 1024 * 1024) {
      return {
        status: 200,
        body: {
          status: 'completed',
          progress: 100,
          videoUrl: `data:video/mp4;base64,${infVideo.buffer.toString('base64')}`,
          mastered: false,
          prompt: cleanPrompt,
          duration,
          aspectRatio,
          quality,
          model: infVideo.model,
        },
      };
    }
  }

  if (getGeminiApiKey()) {
    const veoVideo = await generateViaGeminiVeoVideo(compiledPrompt, aspectRatio, duration);
    if (veoVideo && veoVideo.buffer.length <= 4 * 1024 * 1024) {
      return {
        status: 200,
        body: {
          status: 'completed',
          progress: 100,
          videoUrl: `data:video/mp4;base64,${veoVideo.buffer.toString('base64')}`,
          mastered: false,
          prompt: cleanPrompt,
          duration,
          aspectRatio,
          quality,
          model: veoVideo.model,
        },
      };
    }
  }

  // 2. Submit fastest live Space tier
  for (let tierIdx = 0; tierIdx < WAN_SPACE_TIERS.length; tierIdx++) {
    const submitted = await submitWanSpaceTier(tierIdx, cleanPrompt, aspectRatio, duration, quality);
    if (submitted.eventId) {
      const jobId = encodeStatelessVideoJob({
        v: 1,
        p: cleanPrompt,
        d: duration,
        a: aspectRatio,
        q: quality,
        t: tierIdx,
        e: submitted.eventId,
        st: startedAt,
        pr: 8,
        qc: 0,
      });
      return {
        status: 202,
        body: {
          jobId,
          status: 'processing',
          progress: 8,
          duration,
          aspectRatio,
          quality,
        },
      };
    }
  }

  return {
    status: 503,
    body: {
      status: 'failed',
      error: 'Video generation servers are currently busy. Please try again in a moment.',
    },
  };
}

export async function pollStatelessVideoJob(
  state: StatelessVideoState,
  sseTimeoutMs: number = 22000
): Promise<{ status: number; body: any }> {
  const tier = WAN_SPACE_TIERS[state.t];
  if (!tier) {
    return {
      status: 200,
      body: {
        jobId: encodeStatelessVideoJob(state),
        status: 'failed',
        error: 'Video generation servers are currently busy. Please try again in a moment.',
      },
    };
  }

  const token = getHfAccessToken();
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}`, 'X-HF-Token': token }
    : {};

  let lastProgress = Math.max(8, Math.min(95, state.pr || 10));
  let hadQuotaError = false;

  try {
    const sseRes = await fetch(
      `${tier.baseUrl}/gradio_api/call${tier.endpoint}/${state.e}`,
      {
        headers: authHeaders,
        signal: AbortSignal.timeout(sseTimeoutMs),
      }
    );

    if (sseRes.ok && sseRes.body) {
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let hadError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;

        const indexMatch = chunk.match(/"index":\s*(\d+)\s*,\s*"length":\s*(\d+)/);
        if (indexMatch) {
          const idx = Number(indexMatch[1]);
          const len = Math.max(1, Number(indexMatch[2]));
          const ratio = Math.min(0.97, (idx + 1) / len);
          lastProgress = Math.max(
            lastProgress,
            Math.round(tier.startPct + ratio * (tier.endPct - tier.startPct))
          );
        }

        if (fullText.includes('event: error')) {
          hadError = true;
          hadQuotaError = /ZeroGPU quota|exceeded your.*quota/i.test(fullText);
          try {
            await reader.cancel();
          } catch {}
          break;
        }

        const quickUrl = extractGradioVideoUrl(fullText, tier.baseUrl);
        if (quickUrl && fullText.includes('event: complete')) {
          try {
            await reader.cancel();
          } catch {}
          return {
            status: 200,
            body: {
              jobId: encodeStatelessVideoJob(state),
              status: 'completed',
              progress: 100,
              videoUrl: quickUrl,
              mastered: false,
              prompt: state.p,
              duration: state.d,
              aspectRatio: state.a,
              quality: state.q,
              model: tier.model,
            },
          };
        }
      }

      if (!hadError && !fullText.includes('event: error')) {
        const rawUrl = extractGradioVideoUrl(fullText, tier.baseUrl);
        if (rawUrl) {
          return {
            status: 200,
            body: {
              jobId: encodeStatelessVideoJob(state),
              status: 'completed',
              progress: 100,
              videoUrl: rawUrl,
              mastered: false,
              prompt: state.p,
              duration: state.d,
              aspectRatio: state.a,
              quality: state.q,
              model: tier.model,
            },
          };
        }
      }
    }
  } catch {
    // Tier errored or timed out; advance cleanly to next tier below
  }

  // If shared server IP hit ZeroGPU quota across 2 consecutive tiers without an HF_TOKEN, fail fast so browser direct edge takes over immediately
  const nextQuotaCount = hadQuotaError ? (state.qc || 0) + 1 : 0;
  if (!token && nextQuotaCount >= 2) {
    return {
      status: 200,
      body: {
        jobId: encodeStatelessVideoJob(state),
        status: 'failed',
        quotaLimited: true,
        progress: lastProgress,
        error: 'Server ZeroGPU quota reached; handing off to direct generation.',
      },
    };
  }

  // Try next Space tier
  for (let nextIdx = state.t + 1; nextIdx < WAN_SPACE_TIERS.length; nextIdx++) {
    const submitted = await submitWanSpaceTier(nextIdx, state.p, state.a, state.d, state.q);
    if (submitted.eventId) {
      const nextProgress = Math.max(lastProgress, Math.min(85, lastProgress + 6));
      const nextJobId = encodeStatelessVideoJob({
        ...state,
        t: nextIdx,
        e: submitted.eventId,
        pr: nextProgress,
        qc: nextQuotaCount,
      });
      return {
        status: 200,
        body: {
          jobId: nextJobId,
          nextJobId,
          status: 'processing',
          progress: nextProgress,
          prompt: state.p,
          duration: state.d,
          aspectRatio: state.a,
          quality: state.q,
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      jobId: encodeStatelessVideoJob(state),
      status: 'failed',
      progress: 0,
      error: 'Video generation servers are currently busy. Please try again in a moment.',
    },
  };
}
