export interface BloopxRuntimeConfig {
  phpProxyUrl?: string;
  xkiroEndpoint?: string;
  xkiroModel?: string;
  xkiroApiKey?: string;
  hfToken?: string;
  hfRouterEndpoint?: string;
  hfVideoSpaces?: string[];
  requestTimeoutMs?: number;
}

declare global {
  interface Window {
    BLOOPX_CONFIG?: BloopxRuntimeConfig;
  }
}

export class ProxyRequestError extends Error {
  status: number;
  isHtmlResponse: boolean;
  isPhpUnparsed: boolean;
  isQuotaExceeded: boolean;
  rawSnippet: string;

  constructor(
    message: string,
    opts?: {
      status?: number;
      isHtmlResponse?: boolean;
      isPhpUnparsed?: boolean;
      isQuotaExceeded?: boolean;
      rawSnippet?: string;
    }
  ) {
    super(message);
    this.name = 'ProxyRequestError';
    this.status = opts?.status ?? 0;
    this.isHtmlResponse = Boolean(opts?.isHtmlResponse);
    this.isPhpUnparsed = Boolean(opts?.isPhpUnparsed);
    this.isQuotaExceeded = Boolean(opts?.isQuotaExceeded);
    this.rawSnippet = opts?.rawSnippet ?? '';
  }
}

export function getAppConfig(): Required<BloopxRuntimeConfig> {
  const cfg = (typeof window !== 'undefined' && window.BLOOPX_CONFIG) || {};
  const spaces = Array.isArray(cfg.hfVideoSpaces)
    ? cfg.hfVideoSpaces.filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    : [];

  return {
    phpProxyUrl:
      typeof cfg.phpProxyUrl === 'string' && cfg.phpProxyUrl.trim()
        ? cfg.phpProxyUrl.trim()
        : './generate.php',
    xkiroEndpoint:
      typeof cfg.xkiroEndpoint === 'string' && cfg.xkiroEndpoint.trim()
        ? cfg.xkiroEndpoint.trim()
        : 'https://api.xkiro.com/v1/chat/completions',
    xkiroModel:
      typeof cfg.xkiroModel === 'string' && cfg.xkiroModel.trim()
        ? cfg.xkiroModel.trim()
        : 'sensenova/sensenova-6.8-flash-lite',
    xkiroApiKey: typeof cfg.xkiroApiKey === 'string' ? cfg.xkiroApiKey.trim() : '',
    hfToken: typeof cfg.hfToken === 'string' ? cfg.hfToken.trim() : '',
    hfRouterEndpoint:
      typeof cfg.hfRouterEndpoint === 'string' && cfg.hfRouterEndpoint.trim()
        ? cfg.hfRouterEndpoint.trim()
        : 'https://router.huggingface.co/v1/chat/completions',
    hfVideoSpaces:
      spaces.length > 0
        ? spaces
        : [
            'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
            'https://upsampler-wan-2-2-5b-video.hf.space',
            'https://yujiwang0606-rcm-wan.hf.space',
            'https://numanajmal0-wan-video-api.hf.space',
          ],
    requestTimeoutMs:
      typeof cfg.requestTimeoutMs === 'number' && cfg.requestTimeoutMs >= 5000
        ? cfg.requestTimeoutMs
        : 28000,
  };
}

function stripHtmlToPlainText(rawHtml: string): string {
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || '';
  const withoutScripts = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();

  if (title && withoutScripts && !withoutScripts.toLowerCase().startsWith(title.toLowerCase())) {
    return `${title}: ${withoutScripts}`.slice(0, 220);
  }
  return (title || withoutScripts).slice(0, 220);
}

/**
 * Safely parses responses from generate.php, gracefully handling JSON errors,
 * HTTP 403/500/503 HTML error pages, InfinityFree anti-bot JS challenges,
 * unparsed PHP source, and malformed payloads.
 */
export async function parseSafeProxyResponse<T = any>(response: Response): Promise<T> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  let rawText = '';
  try {
    rawText = await response.text();
  } catch (readErr: any) {
    throw new ProxyRequestError(
      `Failed to read server response (HTTP ${response.status || 0}): ${readErr?.message || 'stream interrupted'}`,
      { status: response.status }
    );
  }

  const trimmed = rawText.trim();

  // 1. Detect raw unexecuted PHP source (when opened on a static-only host without PHP)
  if (/^<\?(?:php|=)/i.test(trimmed) || trimmed.includes('curl_init(')) {
    throw new ProxyRequestError(
      'generate.php returned raw PHP source code instead of executing. Make sure your hosting supports PHP (e.g., InfinityFree htdocs).',
      {
        status: response.status,
        isPhpUnparsed: true,
        rawSnippet: trimmed.slice(0, 140),
      }
    );
  }

  // 2. Empty response body
  if (!trimmed) {
    throw new ProxyRequestError(
      `Server returned an empty response (HTTP ${response.status || 0}). On shared hosting, the PHP script may have hit a time or memory limit.`,
      { status: response.status }
    );
  }

  // 3. Detect unexpected HTML / HTTP 403 / 503 / InfinityFree aes.js challenge / PHP fatal HTML
  const looksLikeHtml =
    contentType.includes('text/html') ||
    /^<(?:!doctype|html|head|body|title|br|b|h1|p|div|center)\b/i.test(trimmed);

  if (looksLikeHtml) {
    const snippet = stripHtmlToPlainText(trimmed);
    const isInfinityFreeBotChallenge =
      /aes\.js|__test|requires javascript|slowAES|bot protection|cloudflare|just a moment/i.test(
        trimmed
      );
    const isPhpFatal = /fatal error|parse error|warning:|uncaught/i.test(trimmed);

    let friendlyMsg = '';
    if (isInfinityFreeBotChallenge) {
      friendlyMsg = `Host security challenge blocked the request (HTTP ${response.status || 403}). Reload the page with cookies enabled on InfinityFree and try again.`;
    } else if (response.status === 403) {
      friendlyMsg = `HTTP 403 Forbidden (HTML response from host)${snippet ? `: ${snippet}` : '. Check InfinityFree file permissions or ModSecurity rules.'}`;
    } else if (response.status === 404) {
      friendlyMsg = `HTTP 404 Not Found: generate.php was not found at the configured path (${getAppConfig().phpProxyUrl}). Verify it is uploaded inside htdocs.`;
    } else if (isPhpFatal) {
      friendlyMsg = `PHP execution error on server (HTTP ${response.status || 500}): ${snippet || 'Check PHP cURL extension and php-config.php syntax.'}`;
    } else {
      friendlyMsg = `Unexpected HTML response (HTTP ${response.status || 0})${snippet ? `: ${snippet}` : '.'}`;
    }

    throw new ProxyRequestError(friendlyMsg, {
      status: response.status,
      isHtmlResponse: true,
      rawSnippet: snippet,
    });
  }

  // 4. Parse JSON safely
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProxyRequestError(
      `Invalid non-JSON response from generate.php (HTTP ${response.status || 0}): ${trimmed.slice(0, 180)}`,
      { status: response.status, rawSnippet: trimmed.slice(0, 180) }
    );
  }

  const upstreamErrorText =
    (typeof parsed?.error === 'string' && parsed.error.trim()) ||
    (typeof parsed?.message === 'string' && parsed.message.trim()) ||
    '';
  const isQuota = Boolean(
    parsed?.quotaExceeded ||
      /ZeroGPU quota|exceeded your.*quota|rate.?limit/i.test(upstreamErrorText)
  );

  if (!response.ok || parsed?.ok === false || (upstreamErrorText && !parsed?.imageUrl && !parsed?.content && !parsed?.videoUrl && !parsed?.eventId)) {
    const detailText =
      typeof parsed?.detail === 'string' && parsed.detail.trim() ? ` (${parsed.detail.trim()})` : '';
    const msg =
      upstreamErrorText
        ? `${upstreamErrorText}${detailText}`
        : `Request failed with HTTP ${response.status || 500}.`;

    throw new ProxyRequestError(msg, {
      status: Number(parsed?.httpStatus || response.status || 500),
      isQuotaExceeded: isQuota,
      rawSnippet: upstreamErrorText,
    });
  }

  return parsed as T;
}

export async function postToGeneratePhp<T = any>(
  payload: Record<string, any>,
  timeoutMs?: number
): Promise<T> {
  const cfg = getAppConfig();
  const effectiveTimeout = timeoutMs ?? cfg.requestTimeoutMs;

  const enrichedPayload: Record<string, any> = {
    ...payload,
    xkiroEndpoint: payload.xkiroEndpoint || cfg.xkiroEndpoint,
    xkiroModel: payload.xkiroModel || cfg.xkiroModel,
    hfRouterEndpoint: payload.hfRouterEndpoint || cfg.hfRouterEndpoint,
    ...(cfg.xkiroApiKey ? { xkiroApiKey: cfg.xkiroApiKey } : {}),
    ...(cfg.hfToken ? { hfToken: cfg.hfToken } : {}),
  };

  let response: Response;
  try {
    response = await fetch(cfg.phpProxyUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(enrichedPayload),
      signal: AbortSignal.timeout(effectiveTimeout),
    });
  } catch (netErr: any) {
    if (netErr?.name === 'TimeoutError' || netErr?.name === 'AbortError') {
      throw new ProxyRequestError(
        `Request timed out after ${Math.round(effectiveTimeout / 1000)}s waiting for ${cfg.phpProxyUrl}. Shared hosting servers often cap long requests; please try again.`,
        { status: 504 }
      );
    }
    throw new ProxyRequestError(
      `Network error reaching ${cfg.phpProxyUrl}: ${netErr?.message || 'Unable to connect to PHP backend.'}`,
      { status: 0 }
    );
  }

  return parseSafeProxyResponse<T>(response);
}

export function formatReadableProxyError(err: unknown, fallbackMessage: string): string {
  if (err instanceof ProxyRequestError) {
    return err.message;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallbackMessage;
}
