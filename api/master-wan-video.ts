import {
  normalizeVideoAspect,
  normalizeVideoDuration,
  normalizeVideoQuality,
  WAN22_14B_T2V_MODEL,
} from './_lib/ai-core.js';
import {
  type ApiRequest,
  type ApiResponse,
  isAllowedHfSpaceUrl,
  readJsonBody,
  sendJson,
} from './_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const {
      rawVideoUrl,
      duration: rawDuration,
      aspectRatio: rawAspect,
      quality: rawQuality,
    } = body || {};

    if (!rawVideoUrl || !isAllowedHfSpaceUrl(rawVideoUrl)) {
      sendJson(res, 400, { error: 'Valid Hugging Face Space Wan video URL is required.' });
      return;
    }

    const duration = normalizeVideoDuration(rawDuration);
    const aspectRatio = normalizeVideoAspect(rawAspect);
    const quality = normalizeVideoQuality(rawQuality);

    sendJson(res, 200, {
      status: 'completed',
      progress: 100,
      videoUrl: rawVideoUrl,
      mastered: false,
      duration,
      aspectRatio,
      quality,
      model: WAN22_14B_T2V_MODEL,
    });
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || 'Failed to process Wan video clip.' });
  }
}
