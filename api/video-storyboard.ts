import { planVideoStoryboardFrames } from './_lib/ai-core.js';
import { type ApiRequest, type ApiResponse, readJsonBody, sendJson } from './_lib/http.js';

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
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const count = Number(body?.frameCount) === 2 ? 2 : 3;
    if (!prompt) {
      sendJson(res, 400, { error: 'prompt is required' });
      return;
    }

    const framePrompts = await planVideoStoryboardFrames(prompt, count);
    sendJson(res, 200, { framePrompts });
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || 'Unable to plan storyboard frames.' });
  }
}
