import { transcribeAudioWithGemini } from './_lib/ai-core.js';
import { type ApiRequest, type ApiResponse, getHeaderValue, readJsonBody, sendJson } from './_lib/http.js';

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
    const { audioData, mimeType, transcriptHint } = body || {};
    if (!audioData || typeof audioData !== 'string') {
      sendJson(res, 400, { error: 'audioData is required' });
      return;
    }

    const transcribed = await transcribeAudioWithGemini(
      audioData,
      mimeType,
      getHeaderValue(req, 'x-hf-token'),
      typeof transcriptHint === 'string' ? transcriptHint : undefined
    );
    sendJson(res, 200, { text: transcribed });
  } catch (err: any) {
    sendJson(res, 200, { text: '', warning: err?.message || 'Transcription unavailable' });
  }
}
