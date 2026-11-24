import { handleGenerateImageRequest } from './_lib/ai-core.js';
import {
  type ApiRequest,
  type ApiResponse,
  getHeaderValue,
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
    const result = await handleGenerateImageRequest(
      body,
      getHeaderValue(req, 'x-hf-token')
    );
    sendJson(res, result.status, result.body);
  } catch (err: any) {
    sendJson(res, 500, {
      error: err?.message || 'Image generation failed. Please try again.',
    });
  }
}
