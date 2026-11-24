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

  const models = [
    'Deliberate',
    'Realistic Vision',
    "ICBINP - I Can't Believe It's Not Photography",
    'Edge Of Realism',
    'majicMIX realistic',
    'stable_diffusion',
  ];

  const submitJob = (w: number, h: number, steps: number, useModels: string[]) =>
    fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: '0000000000',
        'Client-Agent': 'BloopX:1.0:client',
      },
      body: JSON.stringify({
        prompt: `${fullPrompt} ### cartoon, anime, illustration, cgi, 3d render, watermark, text, blurry, deformed`,
        ...(sourceImageBase64
          ? {
              source_image: sourceImageBase64.includes(',')
                ? sourceImageBase64.split(',')[1]
                : sourceImageBase64,
              source_processing: 'img2img',
            }
          : {}),
        params: {
          width: w,
          height: h,
          steps,
          ...(sourceImageBase64 ? { denoising_strength: Number(denoisingStrength.toFixed(2)) } : {}),
          n: 1,
          cfg_scale: sourceImageBase64 ? 7.5 : 7,
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
      res = await submitJob(hordeW, hordeH, 16, models);
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 1300));
        continue;
      }
      if (res.status === 403 || res.status === 400) {
        res = await submitJob(512, 512, 12, ['Deliberate', 'Realistic Vision', 'stable_diffusion']);
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

// Server-assisted + browser-direct keyframe synthesizer (leverages HF_TOKEN on server first, then staggered browser providers)
export async function generateTier5KeyframeInBrowser(
  framePrompt: string,
  aspectRatio: PhotoAspectRatio,
  quality: PhotoQuality
): Promise<string | null> {
  let serverHordeJobId: string | null = null;
  let compiledPrompt = framePrompt;

  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: framePrompt,
        aspectRatio,
        quality,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data: any = await res.json();
      if (typeof data?.imageUrl === 'string' && data.imageUrl.length > 20) {
        return data.imageUrl;
      }
      if (typeof data?.compiledPrompt === 'string' && data.compiledPrompt) {
        compiledPrompt = data.compiledPrompt;
      }
      if (typeof data?.hordeJobId === 'string' && data.hordeJobId) {
        serverHordeJobId = data.hordeJobId;
      }
    }
  } catch {
    // Fall back to direct browser providers cleanly
  }

  const racers: Array<Promise<string>> = [
    generatePhotoDirectlyInBrowser(framePrompt, aspectRatio, quality, compiledPrompt).then((u) => {
      if (!u) throw new Error('direct_kf_empty');
      return u;
    }),
  ];
  if (serverHordeJobId) {
    racers.push(
      pollAiHordeImageInBrowser(serverHordeJobId, 48000).then((u) => {
        if (!u) throw new Error('horde_kf_empty');
        return u;
      })
    );
  }

  try {
    return await Promise.any(racers);
  } catch {
    return null;
  }
}

function verifyPlayableVideoBlobUrl(blobUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      v.removeAttribute('src');
      v.load();
      resolve(ok);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => finish((v.videoWidth || 0) > 0);
    v.onerror = () => finish(false);
    v.src = blobUrl;
    setTimeout(() => finish(true), 2500);
  });
}

async function recordCanvasSequenceWithMime(
  imgs: HTMLImageElement[],
  targetSeconds: VideoDuration,
  outW: number,
  outH: number,
  quality: VideoQuality,
  mimeType: string,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') return null;

  const stream = canvas.captureStream(30);
  const recorder = mimeType
    ? new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: quality === '480p' ? 2_200_000 : 4_200_000,
      })
    : new MediaRecorder(stream);

  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const drawCoverMotionFrame = (
    img: HTMLImageElement,
    segProgress: number,
    motionIndex: number,
    alpha: number
  ) => {
    const baseScale = Math.max(outW / (img.naturalWidth || outW), outH / (img.naturalHeight || outH));
    let zoom = 1.06;
    let panX = 0.5;
    if (motionIndex % 3 === 0) {
      zoom = 1.0 + 0.12 * segProgress;
    } else if (motionIndex % 3 === 1) {
      zoom = 1.12;
      panX = 0.25 + 0.5 * segProgress;
    } else {
      zoom = 1.12 - 0.12 * segProgress;
    }
    const drawW = (img.naturalWidth || outW) * baseScale * zoom;
    const drawH = (img.naturalHeight || outH) * baseScale * zoom;
    const offsetX = -(drawW - outW) * panX;
    const offsetY = -(drawH - outH) * 0.5;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
    ctx.restore();
  };

  const totalMs = targetSeconds * 1000;
  const segmentMs = totalMs / imgs.length;
  const xfadeMs = 650;

  return await new Promise<string | null>((resolve) => {
    let rafId = 0;
    let safetyTimer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const cleanupTimers = () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (safetyTimer) clearInterval(safetyTimer);
    };

    recorder.onerror = () => {
      cleanupTimers();
      stream.getTracks().forEach((t) => t.stop());
      resolve(null);
    };

    recorder.onstop = () => {
      cleanupTimers();
      stream.getTracks().forEach((t) => t.stop());
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const resolvedMime = chunks[0]?.type || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type: resolvedMime });
      if (blob.size < 4000) {
        resolve(null);
        return;
      }
      resolve(URL.createObjectURL(blob));
    };

    drawCoverMotionFrame(imgs[0], 0, 0, 1);
    recorder.start(250);

    const startTime = performance.now();
    const renderTick = () => {
      if (stopped) return;
      const elapsed = performance.now() - startTime;
      const clamped = Math.min(totalMs, elapsed);
      const rawSeg = Math.floor(clamped / segmentMs);
      const segIdx = Math.min(imgs.length - 1, rawSeg);
      const segElapsed = clamped - segIdx * segmentMs;
      const segProgress = Math.min(1, Math.max(0, segElapsed / segmentMs));

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);
      drawCoverMotionFrame(imgs[segIdx], segProgress, segIdx, 1);

      if (segIdx < imgs.length - 1 && segElapsed > segmentMs - xfadeMs) {
        const blend = (segElapsed - (segmentMs - xfadeMs)) / xfadeMs;
        drawCoverMotionFrame(imgs[segIdx + 1], 0, segIdx + 1, Math.min(1, Math.max(0, blend)));
      }

      const pct = Math.min(98, Math.round(78 + (clamped / totalMs) * 20));
      onProgress?.(pct);

      if (elapsed >= totalMs) {
        stopped = true;
        cleanupTimers();
        try {
          if (typeof recorder.requestData === 'function' && recorder.state === 'recording') {
            recorder.requestData();
          }
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        } catch {
          resolve(null);
        }
        return;
      }
      rafId = requestAnimationFrame(renderTick);
    };

    rafId = requestAnimationFrame(renderTick);
    // Safety timer keeps rendering advancing smoothly even if rAF pauses briefly
    safetyTimer = setInterval(renderTick, 120);
  });
}

// Tier 5 ZeroGPU-independent browser 30fps storyboard motion compositor (used only when all 4 Wan Spaces exhaust quota)
export async function composeStoryboardVideoInBrowser(
  frameUrls: string[],
  targetSeconds: VideoDuration,
  aspectRatio: VideoAspectRatio,
  quality: VideoQuality,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  if (frameUrls.length === 0 || typeof MediaRecorder === 'undefined') return null;

  try {
    const loadedImgs: HTMLImageElement[] = [];
    for (const u of frameUrls) {
      try {
        loadedImgs.push(await loadImageElement(u));
      } catch {
        // Skip broken individual frame if another loaded
      }
    }
    if (loadedImgs.length === 0) return null;
    const imgs = loadedImgs.length >= 2 ? loadedImgs : [loadedImgs[0], loadedImgs[0]];

    const [outW, outH] =
      aspectRatio === '9:16'
        ? quality === '480p'
          ? [480, 854]
          : [720, 1280]
        : aspectRatio === '1:1'
        ? quality === '480p'
          ? [480, 480]
          : [720, 720]
        : quality === '480p'
        ? [854, 480]
        : [1280, 720];

    // Prefer native WebM codecs for Chrome/Firefox/Edge canvas recording; fall back to MP4 for Safari
    const mimeCandidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      '',
    ];
    const supportedCodecs = mimeCandidates.filter(
      (m) => m === '' || MediaRecorder.isTypeSupported(m)
    );

    for (const codec of supportedCodecs.slice(0, 2)) {
      const blobUrl = await recordCanvasSequenceWithMime(
        imgs,
        targetSeconds,
        outW,
        outH,
        quality,
        codec,
        onProgress
      );
      if (blobUrl) {
        const playable = await verifyPlayableVideoBlobUrl(blobUrl);
        if (playable) return blobUrl;
        URL.revokeObjectURL(blobUrl);
      }
    }
    return null;
  } catch {
    return null;
  }
}
