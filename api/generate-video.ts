import { startStatelessVideoJob } from './_lib/ai-core.js';
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
    const result = await startStatelessVideoJob(body);
    sendJson(res, result.status, result.body);
  } catch (err: any) {
    sendJson(res, 500, {
      status: 'failed',
      error: err?.message || 'Unable to start video generation.',
    });
  }
}
