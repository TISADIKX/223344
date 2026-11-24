import { decodeStatelessVideoJob, pollStatelessVideoJob } from '../../_lib/ai-core.js';
import { type ApiRequest, type ApiResponse, sendJson } from '../../_lib/http.js';

function extractJobId(req: ApiRequest): string {
  const qVal = req.query?.jobId;
  if (typeof qVal === 'string' && qVal.trim()) return qVal.trim();
  if (Array.isArray(qVal) && qVal[0]) return String(qVal[0]).trim();

  const rawUrl = (req.url || '').split('?')[0];
  const segments = rawUrl.split('/').filter(Boolean);
  return segments[segments.length - 1] ? decodeURIComponent(segments[segments.length - 1]) : '';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const jobId = extractJobId(req);
  const state = decodeStatelessVideoJob(jobId);
  if (!state) {
    sendJson(res, 404, { status: 'failed', error: 'Video generation job not found.' });
    return;
  }

  try {
    const result = await pollStatelessVideoJob(state, 42000);
    sendJson(res, result.status, result.body);
  } catch (err: any) {
    sendJson(res, 200, {
      jobId,
      status: 'failed',
      progress: 0,
      error: err?.message || 'Unable to complete video generation.',
    });
  }
}
