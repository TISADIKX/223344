import type {
  PhotoAspectRatio,
  PhotoQuality,
  VideoAspectRatio,
  VideoDuration,
  VideoQuality,
} from '../types';

export interface FilterEditPlan {
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
  cropAspect?: PhotoAspectRatio | null;
}

const REAL_CAMERA_STYLE_SUFFIX =
  'Captured on Sony A7R V 50mm f/1.8 lens, ISO 400, real candid documentary photography, authentic natural skin pores and subtle imperfections, real fabric weave, subtle 35mm film grain, natural ambient lighting';

function getPhotoCanvasDimensions(
  aspectRatio: PhotoAspectRatio,
  quality: PhotoQuality
): [number, number] {
  const table: Record<PhotoAspectRatio, Record<PhotoQuality, [number, number]>> = {
    '1:1': { standard: [768, 768], hd: [1024, 1024], ultra: [1536, 1536] },
    '16:9': { standard: [896, 504], hd: [1280, 720], ultra: [1792, 1008] },
    '9:16': { standard: [504, 896], hd: [720, 1280], ultra: [1008, 1792] },
    '4:3': { standard: [800, 600], hd: [1152, 864], ultra: [1536, 1152] },
    '3:4': { standard: [600, 800], hd: [864, 1152], ultra: [1152, 1536] },
  };
  return table[aspectRatio][quality];
}

function clamp32(n: number): number {
  return Math.max(512, Math.min(1344, Math.round(n / 32) * 32));
}

function getFluxDimensions(aspectRatio: PhotoAspectRatio, quality: PhotoQuality): [number, number] {
  const [w, h] = getPhotoCanvasDimensions(aspectRatio, quality);
  const scaleDown = Math.max(w, h) > 1344 ? 1344 / Math.max(w, h) : 1;
  return [clamp32(w * scaleDown), clamp32(h * scaleDown)];
}

export function sanitizeRealisticPromptClient(rawPrompt: string): string {
  let s = rawPrompt
    .replace(
      /^(please\s+)?(generate|create|make|draw|give\s+me|show\s+me)\s+(a\s+|an\s+)?(realistic\s+)?(photo|photograph|image|picture)\s+(of\s+)?/i,
      ''
    )
    .replace(/\b(?:do\s+not|don't|no|without)\s+(?:any\s+|a\s+)?(?:hat|cap|helmet|headwear)\b/gi, 'uncovered bare head with visible natural hair')
    .replace(/\b(?:not|never|don't|do\s+not)\s+smil(?:ing|e)\b/gi, 'calm serious neutral facial expression')
    .replace(/\b(?:no|without)\s+(?:glasses|eyeglasses|spectacles|sunglasses)\b/gi, 'clear bare face and eyes')
    .replace(/\b(?:no|without)\s+(?:people|humans|person|crowd)\b/gi, 'empty uninhabited scene')
    .replace(/\b(?:no|without)\s+(?:beard|mustache|facial\s+hair)\b/gi, 'clean-shaven smooth jawline')
    .replace(
      /\b(?:not?\s+a?\s*|don'?t\s+make\s+it\s*|no\s+|without\s+)?(?:cartoon(?:ish|y)?|anime|3d(?:\s+render)?|cgi|illustration|illustrated|animated|painting|drawing|sketch|comic|pixar|disney|ai\s+art|masterpiece)\b/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();

  if (!s) s = rawPrompt.trim();
  return `Unedited RAW 35mm DSLR photograph of ${s}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read blob'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('/')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load error'));
    img.src = src;
  });
}

// Instant pixel-accurate Canvas photo filter editor (for serverless environments without FFmpeg)
export async function applyCanvasPhotoFilterPlan(
  sourceBase64: string,
  sourceMime: string,
  plan: FilterEditPlan,
  aspectRatio: PhotoAspectRatio,
  quality: PhotoQuality
): Promise<string | null> {
  try {
    const cleanB64 = sourceBase64.includes(',') ? sourceBase64.split(',')[1] : sourceBase64;
    const img = await loadImageElement(`data:${sourceMime};base64,${cleanB64}`);
    const [outW, outH] = getPhotoCanvasDimensions(aspectRatio, quality);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const filterParts: string[] = [];
    const bPct = Math.round((1 + Math.max(-0.45, Math.min(0.45, Number(plan.brightness) || 0))) * 100);
    const cPct = Math.round(Math.max(0.4, Math.min(2.0, Number(plan.contrast) || 1)) * 100);
    const sPct = plan.grayscale
      ? 0
      : Math.round(Math.max(0, Math.min(2.4, Number(plan.saturation ?? 1))) * 100);

    if (bPct !== 100) filterParts.push(`brightness(${bPct}%)`);
    if (cPct !== 100) filterParts.push(`contrast(${cPct}%)`);
    if (sPct !== 100) filterParts.push(`saturate(${sPct}%)`);
    if (plan.grayscale) filterParts.push('grayscale(100%)');
    if (plan.sepia || plan.vintage) filterParts.push('sepia(85%)');
    if (plan.invert) filterParts.push('invert(100%)');
    const blurPx = Math.max(0, Math.min(18, Number(plan.blur) || 0));
    if (blurPx > 0.2) filterParts.push(`blur(${blurPx.toFixed(1)}px)`);

    ctx.save();
    if (filterParts.length > 0) {
      ctx.filter = filterParts.join(' ');
    }

    const rotated90or270 = plan.rotate === 90 || plan.rotate === 270;
    const srcW = rotated90or270 ? img.naturalHeight || outH : img.naturalWidth || outW;
    const srcH = rotated90or270 ? img.naturalWidth || outW : img.naturalHeight || outH;
    const scale = Math.max(outW / srcW, outH / srcH);
    const drawW = (img.naturalWidth || outW) * scale;
    const drawH = (img.naturalHeight || outH) * scale;

    ctx.translate(outW / 2, outH / 2);
    if (plan.rotate) {
      ctx.rotate((plan.rotate * Math.PI) / 180);
    }
    ctx.scale(plan.flipH ? -1 : 1, plan.flipV ? -1 : 1);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    const warmth = Math.max(-0.35, Math.min(0.35, Number(plan.warmth) || 0));
    if (warmth !== 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle =
        warmth > 0
          ? `rgba(255, 165, 65, ${(warmth * 0.65).toFixed(2)})`
          : `rgba(75, 150, 255, ${(Math.abs(warmth) * 0.65).toFixed(2)})`;
      ctx.fillRect(0, 0, outW, outH);
      ctx.restore();
    }

    if (plan.vignette || plan.vintage) {
      const grad = ctx.createRadialGradient(
        outW / 2,
        outH / 2,
        Math.min(outW, outH) * 0.34,
        outW / 2,
        outH / 2,
        Math.max(outW, outH) * 0.72
      );
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.48)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, outW, outH);
    }

    return canvas.toDataURL('image/jpeg', 0.92);
  } catch {
    return null;
  }
}

export async function pollAiHordeImageInBrowser(
  jobId: string,
  maxWaitMs: number = 48000
): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1250));
    try {
      const checkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, {
        signal: AbortSignal.timeout(6000),
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
          try {
            const imgRes = await fetch(imgRef, { signal: AbortSignal.timeout(10000) });
            if (imgRes.ok) {
              const blob = await imgRes.blob();
              if (blob.size > 4000) return await blobToDataUrl(blob);
            }
          } catch {
            return imgRef;
          }
          return imgRef;
        }
        return imgRef.startsWith('data:') ? imgRef : `data:image/webp;base64,${imgRef}`;
      }
    } catch {
      // Continue polling on transient network error
    }
  }
  return null;
}

async function callGradioPhotoInBrowser(
  spaceBaseUrl: string,
  dataPayload: unknown[],
  endpointPath: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    const postRes = await fetch(`${spaceBaseUrl}/gradio_api/call${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataPayload }),
      signal: AbortSignal.timeout(8000),
    });
    if (!postRes.ok) return null;
    const postJson: any = await postRes.json();
    const eventId = postJson?.event_id;
    if (!eventId) return null;

    const sseRes = await fetch(`${spaceBaseUrl}/gradio_api/call${endpointPath}/${eventId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!sseRes.ok) return null;

    const text = await sseRes.text();
    if (text.includes('event: error')) return null;

    const match = text.match(/"url":\s*"([^"]+)"/);
    if (!match || !match[1] || match[1].includes('Error:')) return null;

    const imgUrl = match[1].startsWith('http')
      ? match[1]
      : `${spaceBaseUrl}/gradio_api/file=${match[1]}`;

    try {
      const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) });
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        if (blob.size > 4000) return await blobToDataUrl(blob);
      }
    } catch {
      return imgUrl;
    }
    return imgUrl;
  } catch {
    return null;
  }
}

let hordeSlotQueue: Promise<void> = Promise.resolve();

function acquireHordeSubmitSlot(minGapMs: number = 800): Promise<void> {
  const prev = hordeSlotQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  hordeSlotQueue = current;
  return prev.then(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
          release();
        }, minGapMs);
      })
  );
}

async function resizeSourceBase64ForHorde(
  sourceImageBase64: string,
  targetW: number,
  targetH: number
): Promise<string> {
  const cleanRaw = sourceImageBase64.includes(',')
    ? sourceImageBase64.split(',')[1]
    : sourceImageBase64;
  try {
    const dataUri = sourceImageBase64.startsWith('data:')
      ? sourceImageBase64
      : `data:image/jpeg;base64,${cleanRaw}`;
    const img = await loadImageElement(dataUri);
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return cleanRaw;

    const scale = Math.max(targetW / (img.naturalWidth || targetW), targetH / (img.naturalHeight || targetH));
    const drawW = (img.naturalWidth || targetW) * scale;
    const drawH = (img.naturalHeight || targetH) * scale;
    ctx.drawImage(img, (targetW - drawW) / 2, (targetH - drawH) / 2, drawW, drawH);
    const out = canvas.toDataURL('image/jpeg', 0.86);
    return out.split(',')[1] || cleanRaw;
  } catch {
    return cleanRaw;
  }
}

async function submitAiHordePhotoInBrowser(
  fullPrompt: string,
  aspectRatio: PhotoAspectRatio,
  sourceImageBase64?: string,
  denoisingStrength: number = 0.58
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

  const preparedSourceB64 = sourceImageBase64
    ? await resizeSourceBase64ForHorde(sourceImageBase64, hordeW, hordeH)
    : undefined;

  const models = [
    'Deliberate',
    'Realistic Vision',
    "ICBINP - I Can't Believe It's Not Photography",
    'Edge Of Realism',
    'majicMIX realistic',
    'stable_diffusion',
  ];

  const submitJob = (srcB64: string | undefined, w: number, h: number, steps: number, useModels: string[]) =>
    fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: '0000000000',
        'Client-Agent': 'BloopX:1.0:client',
      },
      body: JSON.stringify({
        prompt: `${fullPrompt} ### cartoon, anime, illustration, cgi, 3d render, watermark, text, blurry, deformed`,
        ...(srcB64
          ? {
              source_image: srcB64,
              source_processing: 'img2img',
            }
          : {}),
        params: {
          width: w,
          height: h,
          steps,
          ...(srcB64 ? { denoising_strength: Number(denoisingStrength.toFixed(2)) } : {}),
          n: 1,
          cfg_scale: srcB64 ? 7.5 : 7,
          sampler_name: 'k_euler',
        },
        models: useModels,
        nsfw: false,
        censor_nsfw: true,
        r2: true,
      }),
      signal: AbortSignal.timeout(9000),
    });

  try {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await acquireHordeSubmitSlot(attempt === 0 ? 750 : 1400);
      res = await submitJob(preparedSourceB64, hordeW, hordeH, 16, models);
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 1300));
        continue;
      }
      if (res.status === 403 || res.status === 400) {
        const squareSrc = sourceImageBase64
          ? await resizeSourceBase64ForHorde(sourceImageBase64, 512, 512)
          : undefined;
        res = await submitJob(squareSrc, 512, 512, 12, ['Deliberate', 'Realistic Vision', 'stable_diffusion']);
      }
      break;
    }
    if (!res || !res.ok) return null;
    const data: any = await res.json();
    const jobId = data?.id;
    if (!jobId) return null;
    return await pollAiHordeImageInBrowser(jobId, 48000);
  } catch {
    return null;
  }
}

export async function generatePhotoDirectlyInBrowser(
  rawPrompt: string,
  aspectRatio: PhotoAspectRatio,
  quality: PhotoQuality,
  compiledPrompt?: string
): Promise<string | null> {
  const scenePrompt = compiledPrompt || sanitizeRealisticPromptClient(rawPrompt);
  const framingHint =
    aspectRatio === '16:9' || aspectRatio === '4:3'
      ? 'wide horizontal composition'
      : aspectRatio === '9:16' || aspectRatio === '3:4'
      ? 'vertical portrait framing'
      : 'balanced square framing';
  const fullPrompt = `${scenePrompt}, ${framingHint}. ${REAL_CAMERA_STYLE_SUFFIX}`;
  const [fluxW, fluxH] = getFluxDimensions(aspectRatio, quality);
  const seed = Math.floor(Math.random() * 2147483647);
  const fluxSteps = quality === 'ultra' ? 6 : 4;

  // Race FLUX.1-schnell + Z-Image-Turbo + AI Horde simultaneously from user's own IP
  try {
    return await Promise.any([
      callGradioPhotoInBrowser(
        'https://black-forest-labs-flux-1-schnell.hf.space',
        [fullPrompt, seed, true, fluxW, fluxH, fluxSteps],
        '/infer',
        14000
      ).then((u) => {
        if (!u) throw new Error('flux_empty');
        return u;
      }),
      callGradioPhotoInBrowser(
        'https://tongyi-mai-z-image-turbo.hf.space',
        [fullPrompt, fluxW, fluxH, 9, seed, true],
        '/generate',
        12000
      ).then((u) => {
        if (!u) throw new Error('zimage_empty');
        return u;
      }),
      submitAiHordePhotoInBrowser(`${scenePrompt}, ${framingHint}`, aspectRatio).then((u) => {
        if (!u) throw new Error('horde_empty');
        return u;
      }),
    ]);
  } catch {
    return null;
  }
}

export async function editPhotoDirectlyInBrowser(
  sourceBase64: string,
  editInstruction: string,
  aspectRatio: PhotoAspectRatio,
  editedPrompt?: string,
  strength: number = 0.58
): Promise<string | null> {
  const finalPrompt =
    editedPrompt ||
    `Edited realistic 35mm DSLR photograph based on the reference image, ${editInstruction}, preserving the main subject identity, pose, and natural lighting cleanly`;
  return await submitAiHordePhotoInBrowser(finalPrompt, aspectRatio, sourceBase64, strength);
}

function getTargetVideoDimensions(
  aspectRatio: VideoAspectRatio,
  quality: VideoQuality
): [number, number] {
  const table: Record<VideoAspectRatio, Record<VideoQuality, [number, number]>> = {
    '16:9': { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] },
    '9:16': { '480p': [480, 854], '720p': [720, 1280], '1080p': [1080, 1920] },
    '1:1': { '480p': [480, 480], '720p': [720, 720], '1080p': [1080, 1080] },
  };
  return table[aspectRatio][quality];
}

async function recordCanvasWithFallbackCodecs(
  canvas: HTMLCanvasElement,
  durationMs: number,
  fps: number,
  quality: VideoQuality,
  renderAtElapsed: (elapsedMs: number) => void,
  onProgress?: (pct: number) => void,
  progressStart: number = 84
): Promise<Blob | null> {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof canvas.captureStream !== 'function'
  ) {
    return null;
  }

  // Prefer VP8/VP9 WebM before MP4 because avc1.42E01E (Level 3.0) rejects 720p/1080p on Chrome
  const mimeCandidates = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4',
    '',
  ].filter((m) => m === '' || MediaRecorder.isTypeSupported(m));

  const bps = quality === '1080p' ? 5_500_000 : quality === '720p' ? 3_500_000 : 1_800_000;

  for (const mimeType of mimeCandidates) {
    let stream: MediaStream | null = null;
    try {
      stream = canvas.captureStream(fps);
      const options: MediaRecorderOptions = mimeType
        ? { mimeType, videoBitsPerSecond: bps }
        : { videoBitsPerSecond: bps };

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      }

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const recordedPromise = new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          const outType = (mimeType || recorder.mimeType || 'video/webm').split(';')[0];
          resolve(new Blob(chunks, { type: outType }));
        };
        recorder.onerror = () => reject(new Error('MediaRecorder error'));
      });

      renderAtElapsed(0);
      recorder.start(250);

      const startWall = performance.now();
      await new Promise<void>((resolve) => {
        let timerId: ReturnType<typeof setTimeout> | null = null;
        let rafId = 0;
        let finished = false;

        const finishLoop = () => {
          if (finished) return;
          finished = true;
          if (timerId) clearTimeout(timerId);
          if (rafId) cancelAnimationFrame(rafId);
          resolve();
        };

        const step = () => {
          if (finished) return;
          const elapsed = performance.now() - startWall;
          const clampedElapsed = Math.min(durationMs, Math.max(0, elapsed));
          renderAtElapsed(clampedElapsed);
          const ratio = durationMs > 0 ? clampedElapsed / durationMs : 1;
          onProgress?.(Math.min(99, Math.round(progressStart + ratio * (99 - progressStart))));
          if (elapsed >= durationMs) {
            finishLoop();
            return;
          }
          rafId = requestAnimationFrame(step);
        };

        // Heartbeat fallback timer in case background throttling pauses requestAnimationFrame
        const bgTick = () => {
          if (finished) return;
          const elapsed = performance.now() - startWall;
          if (elapsed >= durationMs) {
            renderAtElapsed(durationMs);
            finishLoop();
            return;
          }
          timerId = setTimeout(bgTick, 120);
        };

        rafId = requestAnimationFrame(step);
        timerId = setTimeout(bgTick, 120);
      });

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      const outBlob = await recordedPromise;
      stream.getTracks().forEach((t) => t.stop());

      if (outBlob.size >= 4000) {
        return outBlob;
      }
    } catch {
      try {
        stream?.getTracks().forEach((t) => t.stop());
      } catch {}
    }
  }

  return null;
}

export async function conformVideoToSettingsInBrowser(
  videoUrl: string,
  targetDuration: VideoDuration,
  aspectRatio: VideoAspectRatio,
  quality: VideoQuality,
  serverMastered: boolean = false,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  if (!videoUrl) return null;

  let sourceBlobUrl: string | null = null;
  let shouldRevokeSource = false;
  let videoEl: HTMLVideoElement | null = null;
  const capturedFrames: HTMLCanvasElement[] = [];

  try {
    if (videoUrl.startsWith('blob:') || videoUrl.startsWith('data:')) {
      sourceBlobUrl = videoUrl;
    } else {
      const res = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size < 4000) return null;
      sourceBlobUrl = URL.createObjectURL(blob);
      shouldRevokeSource = true;
    }

    const video = document.createElement('video');
    videoEl = video;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.top = '-9999px';
    video.style.width = '2px';
    video.style.height = '2px';
    video.style.opacity = '0.01';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);
    video.src = sourceBlobUrl;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('video metadata timeout')), 14000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('video load error'));
      };
    });

    const rawDuration = Number.isFinite(video.duration) && video.duration > 0.2 ? video.duration : 0;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    const [outW, outH] = getTargetVideoDimensions(aspectRatio, quality);
    const targetRatio = outW / outH;
    const actualRatio = vw > 0 && vh > 0 ? vw / vh : targetRatio;
    const durationMatches = rawDuration > 0 && Math.abs(rawDuration - targetDuration) <= 0.45;
    const aspectMatches = Math.abs(actualRatio - targetRatio) <= 0.06;
    const qualityMatches = vw >= outW * 0.9 && vh >= outH * 0.9;

    // Return immediately ONLY when BOTH server mastered it OR exact duration, aspect ratio, AND resolution already match
    if ((serverMastered && durationMatches) || (durationMatches && aspectMatches && qualityMatches)) {
      shouldRevokeSource = false;
      onProgress?.(99);
      return sourceBlobUrl;
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      shouldRevokeSource = false;
      return sourceBlobUrl;
    }

    const drawCoverSource = (
      src: CanvasImageSource,
      srcW: number,
      srcH: number,
      targetCtx: CanvasRenderingContext2D,
      dstW: number,
      dstH: number
    ) => {
      const scale = Math.max(dstW / Math.max(1, srcW), dstH / Math.max(1, srcH));
      const drawW = srcW * scale;
      const drawH = srcH * scale;
      targetCtx.drawImage(src, (dstW - drawW) / 2, (dstH - drawH) / 2, drawW, drawH);
    };

    // Wait for first decoded frame ready
    video.currentTime = 0;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      const t = setTimeout(resolve, 2000);
      video.oncanplay = () => {
        clearTimeout(t);
        resolve();
      };
    });

    // Determine whether we need palindrome frame buffer (whenever raw clip is shorter than requested duration)
    const needsExtension = rawDuration > 0.25 && rawDuration < targetDuration - 0.35;
    const captureScale = Math.min(1, 768 / Math.max(outW, outH));
    const capW = Math.max(240, Math.round((outW * captureScale) / 2) * 2);
    const capH = Math.max(240, Math.round((outH * captureScale) / 2) * 2);
    const maxCaptured = 64;
    let lastCaptureTime = -1;
    const minCaptureGap = needsExtension ? Math.max(0.04, rawDuration / maxCaptured) : 999;
    let firstPassCompleted = false;

    const gentleRate =
      rawDuration > 0 && rawDuration < targetDuration && rawDuration >= targetDuration * 0.72
        ? Math.max(0.72, rawDuration / targetDuration)
        : 1.0;
    video.playbackRate = needsExtension ? 1.0 : gentleRate;
    await video.play().catch(() => {});

    const targetMs = targetDuration * 1000;
    const outBlob = await recordCanvasWithFallbackCodecs(
      canvas,
      targetMs,
      30,
      quality,
      (elapsedMs) => {
        if (needsExtension && firstPassCompleted && capturedFrames.length >= 2) {
          // Smooth zero-glitch palindrome playback across all captured frames up to exact targetDuration
          const postMs = Math.max(0, elapsedMs - rawDuration * 1000);
          const cycleMs = Math.max(600, rawDuration * 1000);
          const phase = (postMs / cycleMs) % 2;
          const pingPongRatio = phase <= 1 ? phase : 2 - phase;
          const exactIdx = pingPongRatio * (capturedFrames.length - 1);
          const i0 = Math.min(capturedFrames.length - 1, Math.floor(exactIdx));
          const i1 = Math.min(capturedFrames.length - 1, i0 + 1);
          const mix = exactIdx - i0;
          ctx.drawImage(capturedFrames[i0], 0, 0, outW, outH);
          if (i1 !== i0 && mix > 0.05) {
            ctx.save();
            ctx.globalAlpha = mix;
            ctx.drawImage(capturedFrames[i1], 0, 0, outW, outH);
            ctx.restore();
          }
          return;
        }

        const curT = video.currentTime || 0;
        const srcW = video.videoWidth || outW;
        const srcH = video.videoHeight || outH;
        drawCoverSource(video, srcW, srcH, ctx, outW, outH);

        if (needsExtension && !firstPassCompleted) {
          if (
            capturedFrames.length < maxCaptured &&
            (lastCaptureTime < 0 || curT - lastCaptureTime >= minCaptureGap)
          ) {
            const snap = document.createElement('canvas');
            snap.width = capW;
            snap.height = capH;
            const sCtx = snap.getContext('2d');
            if (sCtx) {
              drawCoverSource(video, srcW, srcH, sCtx, capW, capH);
              capturedFrames.push(snap);
              lastCaptureTime = curT;
            }
          }
          if (video.ended || curT >= rawDuration - 0.08) {
            if (capturedFrames.length >= 2) {
              firstPassCompleted = true;
              video.pause();
            } else {
              video.currentTime = 0;
              video.play().catch(() => {});
            }
          }
        } else if (!needsExtension && (video.ended || (rawDuration > 0.5 && curT >= rawDuration - 0.08))) {
          video.currentTime = 0;
          video.play().catch(() => {});
        }
      },
      onProgress,
      85
    );

    video.pause();

    if (outBlob && outBlob.size >= 4000) {
      if (shouldRevokeSource && sourceBlobUrl) {
        URL.revokeObjectURL(sourceBlobUrl);
      }
      onProgress?.(99);
      return URL.createObjectURL(outBlob);
    }

    if (shouldRevokeSource && sourceBlobUrl) {
      shouldRevokeSource = false;
      return sourceBlobUrl;
    }
    return null;
  } catch {
    if (shouldRevokeSource && sourceBlobUrl) {
      shouldRevokeSource = false;
      return sourceBlobUrl;
    }
    return null;
  } finally {
    capturedFrames.length = 0;
    if (videoEl) {
      try {
        videoEl.pause();
        videoEl.src = '';
        videoEl.remove();
      } catch {}
    }
  }
}

async function fetchPollinationsFrameUrl(
  prompt: string,
  width: number,
  height: number,
  seed: number
): Promise<string | null> {
  try {
    const safeW = Math.min(1280, Math.max(384, Math.round(width / 16) * 16));
    const safeH = Math.min(1280, Math.max(384, Math.round(height / 16) * 16));
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      prompt
    )}?width=${safeW}&height=${safeH}&nologo=true&seed=${seed}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(22000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size < 4000) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

export async function generateMultiKeyframeMotionVideoInBrowser(
  rawPrompt: string,
  targetDuration: VideoDuration,
  aspectRatio: VideoAspectRatio,
  quality: VideoQuality,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined' ||
    typeof document.createElement('canvas').captureStream !== 'function'
  ) {
    return null;
  }

  const baseScene = sanitizeRealisticPromptClient(rawPrompt);
  const photoAspect: PhotoAspectRatio =
    aspectRatio === '9:16' ? '9:16' : aspectRatio === '1:1' ? '1:1' : '16:9';
  const [outW, outH] = getTargetVideoDimensions(aspectRatio, quality);

  const sceneCues = [
    `${baseScene}, opening establishing cinema shot, natural motion beginning, crisp 35mm photography`,
    `${baseScene}, dynamic mid-action cinematic frame, natural subject movement and shifting light, crisp 35mm photography`,
    `${baseScene}, atmospheric closing motion frame, cinematic depth of field, crisp 35mm photography`,
  ];

  onProgress?.(48);

  const loadBitmap = (url: string): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      const img = new Image();
      if (!url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('/')) {
        img.crossOrigin = 'anonymous';
      }
      const t = setTimeout(() => resolve(null), 12000);
      img.onload = () => {
        clearTimeout(t);
        resolve(img.naturalWidth > 0 ? img : null);
      };
      img.onerror = () => {
        clearTimeout(t);
        resolve(null);
      };
      img.src = url;
    });

  // Fetch up to 3 distinct keyframes from 3 completely independent backends (no shared IP rate-limit collisions)
  const framePromises: Array<Promise<HTMLImageElement | null>> = [
    // 1. Direct browser HF FLUX / Z-Image / single AI Horde slot
    Promise.race([
      generatePhotoDirectlyInBrowser(sceneCues[0], photoAspect, 'hd').then((u) =>
        u ? loadBitmap(u) : null
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 32000)),
    ]),
    // 2. Single clean Pollinations request
    Promise.race([
      fetchPollinationsFrameUrl(
        sceneCues[1],
        outW > outH ? 896 : outH > outW ? 512 : 768,
        outH > outW ? 896 : outW > outH ? 512 : 768,
        Math.floor(Math.random() * 999999) + 101
      ).then((u) => (u ? loadBitmap(u) : null)),
      new Promise<null>((r) => setTimeout(() => r(null), 26000)),
    ]),
    // 3. Server /api/generate-image (uses Gemini / Xkiro / server providers)
    Promise.race([
      fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: sceneCues[2],
          aspectRatio: photoAspect,
          quality: 'hd',
        }),
        signal: AbortSignal.timeout(26000),
      })
        .then(async (r) => {
          if (!r.ok) return null;
          const j = await r.json().catch(() => null);
          if (typeof j?.imageUrl === 'string' && j.imageUrl) {
            return await loadBitmap(j.imageUrl);
          }
          if (typeof j?.hordeJobId === 'string' && j.hordeJobId) {
            const hUrl = await pollAiHordeImageInBrowser(j.hordeJobId, 28000);
            return hUrl ? await loadBitmap(hUrl) : null;
          }
          return null;
        })
        .catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 30000)),
    ]),
  ];

  let completedCount = 0;
  const loadedFramesRaw = await Promise.all(
    framePromises.map((p) =>
      p.then((img) => {
        completedCount += 1;
        onProgress?.(Math.min(79, 52 + completedCount * 9));
        return img;
      })
    )
  );

  let frames = loadedFramesRaw.filter((img): img is HTMLImageElement => Boolean(img));

  // Last-resort single retry if all 3 timed out simultaneously on weak mobile network
  if (frames.length === 0) {
    const retryUrl =
      (await fetchPollinationsFrameUrl(
        sceneCues[0],
        outW > outH ? 896 : outH > outW ? 512 : 768,
        outH > outW ? 896 : outW > outH ? 512 : 768,
        Math.floor(Math.random() * 999999) + 777
      )) || (await submitAiHordePhotoInBrowser(sceneCues[0], photoAspect));
    if (retryUrl) {
      const retryImg = await loadBitmap(retryUrl);
      if (retryImg) frames = [retryImg];
    }
  }

  if (frames.length === 0) {
    return null;
  }

  onProgress?.(82);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const drawMotionFrame = (
      img: HTMLImageElement,
      zoom: number,
      panXRatio: number,
      panYRatio: number,
      alpha: number
    ) => {
      const iw = img.naturalWidth || outW;
      const ih = img.naturalHeight || outH;
      const baseScale = Math.max(outW / iw, outH / ih);
      const drawW = iw * baseScale * zoom;
      const drawH = ih * baseScale * zoom;
      const slackX = Math.max(0, drawW - outW);
      const slackY = Math.max(0, drawH - outH);
      const x = (outW - drawW) / 2 + panXRatio * (slackX * 0.45);
      const y = (outH - drawH) / 2 + panYRatio * (slackY * 0.45);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x, y, drawW, drawH);
      ctx.restore();
    };

    const targetMs = targetDuration * 1000;
    const outBlob = await recordCanvasWithFallbackCodecs(
      canvas,
      targetMs,
      30,
      quality,
      (elapsedMs) => {
        const tNorm = Math.min(1, Math.max(0, elapsedMs / targetMs));
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, outW, outH);

        if (frames.length === 1) {
          const zoom = 1.04 + 0.08 * tNorm;
          const panX = Math.sin(tNorm * Math.PI) * 0.5;
          const panY = (tNorm - 0.5) * 0.35;
          drawMotionFrame(frames[0], zoom, panX, panY, 1);
          return;
        }

        const scaled = tNorm * (frames.length - 1);
        const idx = Math.min(frames.length - 2, Math.floor(scaled));
        const localT = scaled - idx;
        const smoothMix = localT * localT * (3 - 2 * localT);
        const dir = idx % 2 === 0 ? 1 : -1;

        drawMotionFrame(
          frames[idx],
          1.05 + 0.07 * localT,
          dir * (localT - 0.5) * 0.55,
          (localT - 0.5) * 0.25,
          1
        );
        if (smoothMix > 0.01) {
          drawMotionFrame(
            frames[idx + 1],
            1.05 + 0.07 * (1 - localT),
            -dir * (localT - 0.5) * 0.55,
            (0.5 - localT) * 0.25,
            smoothMix
          );
        }
      },
      onProgress,
      83
    );

    if (!outBlob || outBlob.size < 4000) return null;
    onProgress?.(99);
    return URL.createObjectURL(outBlob);
  } catch {
    return null;
  }
}


