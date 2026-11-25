import {
  getGeminiApiKey,
  getHfAccessToken,
  getXkiroApiKey,
  XKIRO_TEXT_MODELS,
} from './_lib/ai-core.js';
import { type ApiRequest, type ApiResponse, sendJson } from './_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const xkiroKey = getXkiroApiKey();
  const hfToken = getHfAccessToken();
  const geminiKey = getGeminiApiKey();

  sendJson(res, 200, {
    status: 'ok',
    name: 'BloopX API Service',
    time: new Date().toISOString(),
    provider: xkiroKey ? 'Xkiro + Multi-Tier Failover' : 'Multi-Tier Failover',
    hasXkiroKey: !!xkiroKey,
    hasHfToken: !!hfToken,
    hasGeminiKey: !!geminiKey,
    endpoints: {
      chat: {
        status: 'healthy',
        primary: xkiroKey ? 'Xkiro Router' : 'Free Failover Cluster',
        models: XKIRO_TEXT_MODELS,
      },
      photo: {
        status: 'healthy',
        providers: ['Xkiro SenseNova', 'FLUX.1-schnell', 'Z-Image-Turbo', 'AI Horde SDXL'],
      },
      video: {
        status: 'healthy',
        providers: ['Wan 2.2', 'Wan 2.1', 'LTX-Video', 'LTX-2.5'],
      },
      database: {
        status: 'connected',
        id: 'ai-studio-gutiaiplayground-aeb9da6e-3033-483f-a2ca-272cdb80d02c',
      },
    },
  });
}
