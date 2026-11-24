<?php
/**
 * BloopX Lightweight PHP cURL Backend Proxy (InfinityFree & Shared-Hosting Ready)
 *
 * Handles AI Chat, xKiro SenseNova Photo Generation & Editing, Voice Transcription,
 * and Hugging Face Wan Video Generation + Streaming via PHP cURL.
 * Keeps API keys on the server side (via php-config.php) and avoids browser CORS errors.
 */

@ini_set('display_errors', '0');
@error_reporting(0);
if (function_exists('ob_start')) {
    ob_start();
}

$bloopxResponseSent = false;

function bloopx_send_json($statusCode, array $payload) {
    global $bloopxResponseSent;
    $bloopxResponseSent = true;
    if (function_exists('ob_get_level')) {
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
    }
    if (!headers_sent()) {
        http_response_code((int)$statusCode);
        header('Content-Type: application/json; charset=UTF-8');
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

register_shutdown_function(function () {
    global $bloopxResponseSent;
    if ($bloopxResponseSent) {
        return;
    }
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        bloopx_send_json(500, [
            'ok' => false,
            'error' => 'PHP proxy fatal error: ' . ($err['message'] ?? 'Unknown server error'),
            'httpStatus' => 500,
        ]);
    }
});

// Same-origin friendly CORS handling (no wildcard on credentialed calls)
$reqOrigin = isset($_SERVER['HTTP_ORIGIN']) ? trim((string)$_SERVER['HTTP_ORIGIN']) : '';
$reqHost = isset($_SERVER['HTTP_HOST']) ? trim((string)$_SERVER['HTTP_HOST']) : '';
if ($reqOrigin !== '' && $reqHost !== '') {
    $originHost = parse_url($reqOrigin, PHP_URL_HOST);
    $hostOnly = preg_replace('/:\d+$/', '', $reqHost);
    if ($originHost && strcasecmp($originHost, $hostOnly) === 0) {
        header('Access-Control-Allow-Origin: ' . $reqOrigin);
        header('Vary: Origin');
    }
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, Accept');

$method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper($_SERVER['REQUEST_METHOD']) : 'GET';
if ($method === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if (!function_exists('curl_init')) {
    bloopx_send_json(500, [
        'ok' => false,
        'error' => 'PHP cURL extension is not enabled on this server.',
        'httpStatus' => 500,
    ]);
}

// Compatibility helpers for PHP 7.4+
function bloopx_starts_with($haystack, $needle) {
    if ($needle === '') return true;
    return substr((string)$haystack, 0, strlen((string)$needle)) === (string)$needle;
}

function bloopx_contains($haystack, $needle) {
    if ($needle === '') return true;
    return strpos((string)$haystack, (string)$needle) !== false;
}

// Load server-side secrets from php-config.php if available
$serverConfig = [];
$phpConfigPath = __DIR__ . '/php-config.php';
if (is_file($phpConfigPath) && is_readable($phpConfigPath)) {
    $loaded = @include $phpConfigPath;
    if (is_array($loaded)) {
        $serverConfig = $loaded;
    }
}

function bloopx_cfg($key, $default = '') {
    global $serverConfig;
    if (isset($serverConfig[$key]) && is_string($serverConfig[$key]) && trim($serverConfig[$key]) !== '') {
        return trim($serverConfig[$key]);
    }
    $envVal = getenv($key);
    if ($envVal !== false && trim((string)$envVal) !== '') {
        return trim((string)$envVal);
    }
    return $default;
}

// Strict HTTPS allowlist validator to block SSRF / private IP / non-HTTPS targets
function bloopx_is_allowed_url($url, array $allowedExactHosts, array $allowedHostSuffixes = []) {
    if (!is_string($url) || strlen($url) > 2048) return false;
    $parts = @parse_url(trim($url));
    if (!is_array($parts)) return false;
    $scheme = isset($parts['scheme']) ? strtolower($parts['scheme']) : '';
    $host = isset($parts['host']) ? strtolower($parts['host']) : '';
    if ($scheme !== 'https' || $host === '') return false;
    if ($host === 'localhost' || filter_var($host, FILTER_VALIDATE_IP)) {
        return false;
    }
    foreach ($allowedExactHosts as $exact) {
        if ($host === strtolower($exact)) return true;
    }
    foreach ($allowedHostSuffixes as $suffix) {
        $suffix = strtolower($suffix);
        if (strlen($host) > strlen($suffix) && substr($host, -strlen($suffix)) === $suffix) {
            return true;
        }
    }
    return false;
}

function bloopx_strip_html_snippet($raw) {
    $txt = trim(preg_replace('/\s+/', ' ', strip_tags((string)$raw)));
    return substr($txt, 0, 220);
}

function bloopx_curl_request($url, array $opts = []) {
    $ch = curl_init($url);
    $method = isset($opts['method']) ? strtoupper($opts['method']) : 'GET';
    $headers = isset($opts['headers']) && is_array($opts['headers']) ? $opts['headers'] : [];
    $timeout = isset($opts['timeout']) ? (int)$opts['timeout'] : 18;
    $body = isset($opts['body']) ? $opts['body'] : null;

    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, min(8, $timeout));
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_USERAGENT, 'BloopX-PHP-Proxy/1.0');

    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
    }
    if (!empty($headers)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    }

    $respHeaders = [];
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($curl, $headerLine) use (&$respHeaders) {
        $len = strlen($headerLine);
        $parts = explode(':', $headerLine, 2);
        if (count($parts) === 2) {
            $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
        return $len;
    });

    $resBody = curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $curlErrno = curl_errno($ch);
    $curlErr = curl_error($ch);
    curl_close($ch);

    return [
        'ok' => ($curlErrno === 0 && $httpCode >= 200 && $httpCode < 300),
        'httpCode' => $httpCode,
        'contentType' => $contentType,
        'headers' => $respHeaders,
        'body' => is_string($resBody) ? $resBody : '',
        'curlErrno' => $curlErrno,
        'curlError' => $curlErr,
    ];
}

// Read Gradio SSE stream cleanly until event:complete / event:error or deadline
function bloopx_curl_gradio_sse($sseUrl, array $headers = [], $timeoutSec = 21) {
    $buffer = '';
    $doneFlag = false;
    $ch = curl_init($sseUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 7);
    curl_setopt($ch, CURLOPT_TIMEOUT, (int)$timeoutSec);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_USERAGENT, 'BloopX-PHP-Proxy/1.0');
    if (!empty($headers)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    }
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($curl, $chunk) use (&$buffer, &$doneFlag) {
        $buffer .= $chunk;
        if (
            bloopx_contains($buffer, "event: complete") ||
            bloopx_contains($buffer, "event: error")
        ) {
            // Allow remainder of current event line to buffer before closing
            if (preg_match('/event:\s*(?:complete|error)\s*\r?\n\s*data:\s*[^\r\n]+/', $buffer)) {
                $doneFlag = true;
                return 0; // Abort stream cleanly as soon as result or error line arrives
            }
        }
        return strlen($chunk);
    });

    curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    return [
        'httpCode' => $httpCode,
        'text' => $buffer,
        'done' => $doneFlag,
        'curlError' => $curlErr,
    ];
}

function bloopx_extract_text_from_choice($rawContent) {
    if (is_string($rawContent)) return trim($rawContent);
    if (is_array($rawContent)) {
        $out = '';
        foreach ($rawContent as $part) {
            if (is_array($part) && isset($part['text']) && is_string($part['text'])) {
                $out .= $part['text'];
            }
        }
        return trim($out);
    }
    return '';
}

function bloopx_photo_dimensions($aspectRatio, $quality) {
    $table = [
        '1:1'  => ['standard' => [768, 768],  'hd' => [1024, 1024], 'ultra' => [1024, 1024]],
        '16:9' => ['standard' => [896, 512],  'hd' => [1280, 720],  'ultra' => [1344, 768]],
        '9:16' => ['standard' => [512, 896],  'hd' => [720, 1280],  'ultra' => [768, 1344]],
        '4:3'  => ['standard' => [800, 608],  'hd' => [1152, 864],  'ultra' => [1280, 960]],
        '3:4'  => ['standard' => [608, 800],  'hd' => [864, 1152],  'ultra' => [960, 1280]],
    ];
    $ar = isset($table[$aspectRatio]) ? $aspectRatio : '1:1';
    $q = isset($table[$ar][$quality]) ? $quality : 'hd';
    $dims = $table[$ar][$q];
    $clamp32 = function ($n) {
        return (int)max(512, min(1344, round($n / 32) * 32));
    };
    return [$clamp32($dims[0]), $clamp32($dims[1])];
}

function bloopx_resolve_xkiro_url(array $input) {
    $candidate = isset($input['xkiroEndpoint']) && is_string($input['xkiroEndpoint'])
        ? trim($input['xkiroEndpoint'])
        : bloopx_cfg('XKIRO_ENDPOINT', 'https://api.xkiro.com/v1/chat/completions');
    if (bloopx_is_allowed_url($candidate, ['api.xkiro.com'], ['.xkiro.com'])) {
        return $candidate;
    }
    return 'https://api.xkiro.com/v1/chat/completions';
}

function bloopx_resolve_hf_router_url(array $input) {
    $candidate = isset($input['hfRouterEndpoint']) && is_string($input['hfRouterEndpoint'])
        ? trim($input['hfRouterEndpoint'])
        : 'https://router.huggingface.co/v1/chat/completions';
    if (bloopx_is_allowed_url($candidate, ['router.huggingface.co'], ['.huggingface.co'])) {
        return $candidate;
    }
    return 'https://router.huggingface.co/v1/chat/completions';
}

function bloopx_resolve_keys(array $input) {
    // Prefer server-side secrets stored in php-config.php / env, falling back to config.js values if provided
    $serverXkiro = bloopx_cfg('XKIRO_API_KEY', '');
    $clientXkiro = isset($input['xkiroApiKey']) && is_string($input['xkiroApiKey']) ? trim($input['xkiroApiKey']) : '';
    $xkiroKey = $serverXkiro !== '' ? $serverXkiro : $clientXkiro;

    $serverHf = bloopx_cfg('HF_TOKEN', bloopx_cfg('HUGGINGFACE_API_KEY', ''));
    $clientHf = isset($input['hfToken']) && is_string($input['hfToken']) ? trim($input['hfToken']) : '';
    $hfToken = $serverHf !== '' ? $serverHf : $clientHf;

    $geminiKey = bloopx_cfg('GEMINI_API_KEY', '');

    return [$xkiroKey, $hfToken, $geminiKey];
}

function bloopx_call_xkiro_chat($endpointUrl, $apiKey, array $messages, $primaryModel = 'sensenova/sensenova-6.8-flash-lite', $hasImages = false, $maxTokens = 800, $temperature = 0.7) {
    if ($apiKey === '') {
        return ['ok' => false, 'httpCode' => 0, 'error' => 'xKiro API key is not configured in php-config.php or config.js.'];
    }

    $models = $hasImages
        ? [$primaryModel, 'sensenova/sensenova-6.8-flash-lite', 'mistralai/ministral-8b', 'mistralai/mistral-large-2512', 'cohere/command-a-vision']
        : [$primaryModel, 'sensenova/sensenova-6.8-flash-lite', 'mistralai/ministral-8b', 'mistralai/mistral-large-2512', 'mistralai/mistral-small-2603'];
    $models = array_values(array_unique(array_filter($models)));

    $lastErr = 'xKiro request failed.';
    $lastCode = 0;

    foreach ($models as $model) {
        $payload = json_encode([
            'model' => $model,
            'messages' => $messages,
            'max_tokens' => $maxTokens,
            'temperature' => $temperature,
        ]);

        $res = bloopx_curl_request($endpointUrl, [
            'method' => 'POST',
            'headers' => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $apiKey,
            ],
            'body' => $payload,
            'timeout' => 16,
        ]);

        $lastCode = $res['httpCode'];
        if (!$res['ok']) {
            $jsonErr = @json_decode($res['body'], true);
            $msg = isset($jsonErr['error']['message']) ? $jsonErr['error']['message'] : (isset($jsonErr['error']) && is_string($jsonErr['error']) ? $jsonErr['error'] : bloopx_strip_html_snippet($res['body']));
            $lastErr = "xKiro ($model) HTTP " . $res['httpCode'] . ($msg ? ": $msg" : ($res['curlError'] ? ": " . $res['curlError'] : ''));
            if ($res['httpCode'] === 401) {
                return ['ok' => false, 'httpCode' => 401, 'error' => $lastErr];
            }
            continue;
        }

        $data = @json_decode($res['body'], true);
        if (is_array($data)) {
            // Check if endpoint directly returned an image response
            $directImg = null;
            if (!empty($data['imageUrl']) && is_string($data['imageUrl'])) {
                $directImg = $data['imageUrl'];
            } elseif (!empty($data['images'][0]['url'])) {
                $directImg = $data['images'][0]['url'];
            } elseif (!empty($data['images'][0]['b64_json'])) {
                $directImg = 'data:image/jpeg;base64,' . $data['images'][0]['b64_json'];
            } elseif (!empty($data['data'][0]['b64_json'])) {
                $directImg = 'data:image/jpeg;base64,' . $data['data'][0]['b64_json'];
            } elseif (!empty($data['data'][0]['url'])) {
                $directImg = $data['data'][0]['url'];
            }
            if ($directImg !== null) {
                return [
                    'ok' => true,
                    'directImageUrl' => $directImg,
                    'model' => $model,
                ];
            }

            $text = bloopx_extract_text_from_choice($data['choices'][0]['message']['content'] ?? '');
            if ($text !== '') {
                $tokens = isset($data['usage']['total_tokens']) && (int)$data['usage']['total_tokens'] > 0
                    ? (int)$data['usage']['total_tokens']
                    : max(60, (int)ceil((strlen($payload) + strlen($text)) / 4));
                return [
                    'ok' => true,
                    'content' => $text,
                    'tokensUsed' => $tokens,
                    'model' => $model,
                ];
            }
        }
    }

    return ['ok' => false, 'httpCode' => $lastCode, 'error' => $lastErr];
}

// ============================================================================
// GET Endpoints: Health & Allowlisted Video Stream Relay
// ============================================================================
if ($method === 'GET') {
    $getAction = isset($_GET['action']) ? trim((string)$_GET['action']) : 'health';

    if ($getAction === 'video-stream') {
        $targetUrl = isset($_GET['u']) ? trim((string)$_GET['u']) : '';
        $allowedHosts = ['huggingface.co', 'router.huggingface.co'];
        $allowedSuffixes = ['.hf.space', '.huggingface.co', '.fal.media', '.r2.cloudflarestorage.com'];
        if (!bloopx_is_allowed_url($targetUrl, $allowedHosts, $allowedSuffixes)) {
            bloopx_send_json(400, [
                'ok' => false,
                'error' => 'Invalid or disallowed video URL host.',
                'httpStatus' => 400,
            ]);
        }

        $hfToken = bloopx_cfg('HF_TOKEN', bloopx_cfg('HUGGINGFACE_API_KEY', ''));
        $ch = curl_init($targetUrl);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 4);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
        curl_setopt($ch, CURLOPT_TIMEOUT, 25);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_USERAGENT, 'BloopX-PHP-VideoRelay/1.0');
        if ($hfToken !== '') {
            curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $hfToken]);
        }

        $videoBytes = curl_exec($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $cType = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($httpCode < 200 || $httpCode >= 300 || !is_string($videoBytes) || strlen($videoBytes) < 1000) {
            bloopx_send_json($httpCode >= 400 ? $httpCode : 502, [
                'ok' => false,
                'error' => 'Failed to stream generated video from Hugging Face Space (HTTP ' . $httpCode . ')' . ($curlErr ? ': ' . $curlErr : ''),
                'httpStatus' => $httpCode,
            ]);
        }

        if (function_exists('ob_get_level')) {
            while (ob_get_level() > 0) {
                @ob_end_clean();
            }
        }
        $bloopxResponseSent = true;
        $safeMime = bloopx_starts_with(strtolower($cType), 'video/') ? $cType : 'video/mp4';
        header('Content-Type: ' . $safeMime);
        header('Content-Length: ' . strlen($videoBytes));
        header('Accept-Ranges: bytes');
        header('Cache-Control: public, max-age=3600');
        echo $videoBytes;
        exit;
    }

    // Default GET: Health diagnostics
    $xkiroConfigured = bloopx_cfg('XKIRO_API_KEY', '') !== '';
    $hfConfigured = bloopx_cfg('HF_TOKEN', bloopx_cfg('HUGGINGFACE_API_KEY', '')) !== '';
    bloopx_send_json(200, [
        'ok' => true,
        'status' => 'ok',
        'runtime' => 'PHP ' . phpversion(),
        'curlEnabled' => function_exists('curl_init'),
        'hasServerXkiroKey' => $xkiroConfigured,
        'hasServerHfToken' => $hfConfigured,
        'timestamp' => date('c'),
    ]);
}

if ($method !== 'POST') {
    bloopx_send_json(405, [
        'ok' => false,
        'error' => 'Method not allowed. Use POST JSON requests.',
        'httpStatus' => 405,
    ]);
}

$rawBody = file_get_contents('php://input');
$input = @json_decode($rawBody ?: '', true);
if (!is_array($input)) {
    bloopx_send_json(400, [
        'ok' => false,
        'error' => 'Invalid JSON request body sent to generate.php.',
        'httpStatus' => 400,
    ]);
}

$action = isset($input['action']) && is_string($input['action']) ? trim(strtolower($input['action'])) : '';
if ($action === '') {
    if (isset($input['messages'])) {
        $action = 'chat';
    } elseif (isset($input['audioData'])) {
        $action = 'transcribe';
    } else {
        $action = 'image';
    }
}

list($xkiroKey, $hfToken, $geminiKey) = bloopx_resolve_keys($input);
$xkiroEndpoint = bloopx_resolve_xkiro_url($input);
$xkiroModel = isset($input['xkiroModel']) && is_string($input['xkiroModel']) && trim($input['xkiroModel']) !== ''
    ? trim($input['xkiroModel'])
    : bloopx_cfg('XKIRO_MODEL', 'sensenova/sensenova-6.8-flash-lite');
$hfRouterEndpoint = bloopx_resolve_hf_router_url($input);

// ============================================================================
// ACTION: TRANSCRIBE VOICE AUDIO
// ============================================================================
if ($action === 'transcribe') {
    $audioData = isset($input['audioData']) && is_string($input['audioData']) ? $input['audioData'] : '';
    $mimeType = isset($input['mimeType']) && is_string($input['mimeType']) ? explode(';', $input['mimeType'])[0] : 'audio/webm';
    if ($mimeType === 'video/webm') $mimeType = 'audio/webm';
    if ($mimeType === 'video/mp4') $mimeType = 'audio/mp4';

    if ($audioData === '' || strlen($audioData) > 35000000) {
        bloopx_send_json(400, [
            'ok' => false,
            'text' => '',
            'error' => 'Valid audioData under 25MB is required.',
        ]);
    }

    $cleanB64 = bloopx_contains($audioData, ',') ? explode(',', $audioData, 2)[1] : $audioData;
    $audioBytes = base64_decode($cleanB64, true);
    if ($audioBytes === false || strlen($audioBytes) < 100) {
        bloopx_send_json(400, ['ok' => false, 'text' => '', 'error' => 'Invalid audio encoding.']);
    }

    $errors = [];

    // Tier 1: Gemini Speech-to-Text if GEMINI_API_KEY configured
    if ($geminiKey !== '') {
        foreach (['gemini-2.5-flash', 'gemini-3.5-transcribe'] as $gModel) {
            $gPayload = json_encode([
                'contents' => [[
                    'parts' => [
                        ['inlineData' => ['mimeType' => $mimeType, 'data' => base64_encode($audioBytes)]],
                        ['text' => 'Transcribe the spoken words in this audio accurately into plain text. Return only the words spoken.'],
                    ],
                ]],
            ]);
            $gRes = bloopx_curl_request(
                'https://generativelanguage.googleapis.com/v1beta/models/' . urlencode($gModel) . ':generateContent',
                [
                    'method' => 'POST',
                    'headers' => ['Content-Type: application/json', 'x-goog-api-key: ' . $geminiKey],
                    'body' => $gPayload,
                    'timeout' => 15,
                ]
            );
            if ($gRes['ok']) {
                $gJson = @json_decode($gRes['body'], true);
                $txt = trim((string)($gJson['candidates'][0]['content']['parts'][0]['text'] ?? ''));
                $txt = trim($txt, "\"'` \t\n\r");
                if ($txt !== '') {
                    bloopx_send_json(200, ['ok' => true, 'text' => $txt]);
                }
            } else {
                $errors[] = "Gemini($gModel) HTTP " . $gRes['httpCode'];
            }
        }
    }

    // Tier 2: Hugging Face Whisper Inference API
    if ($hfToken !== '') {
        foreach (['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3'] as $wModel) {
            $wRes = bloopx_curl_request('https://router.huggingface.co/hf-inference/models/' . $wModel, [
                'method' => 'POST',
                'headers' => [
                    'Authorization: Bearer ' . $hfToken,
                    'Content-Type: ' . $mimeType,
                ],
                'body' => $audioBytes,
                'timeout' => 16,
            ]);
            if ($wRes['ok']) {
                $wJson = @json_decode($wRes['body'], true);
                $txt = trim((string)($wJson['text'] ?? ''));
                if ($txt !== '') {
                    bloopx_send_json(200, ['ok' => true, 'text' => $txt]);
                }
            } else {
                $errors[] = "HF-Whisper($wModel) HTTP " . $wRes['httpCode'];
                if ($wRes['httpCode'] === 401 || $wRes['httpCode'] === 403) break;
            }
        }
    }

    bloopx_send_json(200, [
        'ok' => true,
        'text' => '',
        'detail' => !empty($errors) ? implode('; ', $errors) : 'No STT API key configured (optional).',
    ]);
}

// ============================================================================
// ACTION: CHAT COMPLETIONS (xKiro Primary + HF Router + Gemini + Pollinations)
// ============================================================================
if ($action === 'chat') {
    $messages = isset($input['messages']) && is_array($input['messages']) ? $input['messages'] : null;
    if (!$messages || count($messages) > 60) {
        bloopx_send_json(400, ['ok' => false, 'error' => 'Valid messages array is required.', 'httpStatus' => 400]);
    }

    $attachments = isset($input['attachments']) && is_array($input['attachments']) ? array_slice($input['attachments'], 0, 10) : [];
    $hasImages = false;
    $imageAtts = [];
    $voiceAtt = null;

    foreach ($attachments as $att) {
        if (!is_array($att) || empty($att['data']) || empty($att['mimeType'])) continue;
        $mType = strtolower((string)$att['mimeType']);
        if (bloopx_starts_with($mType, 'image/')) {
            $hasImages = true;
            $imageAtts[] = $att;
        } elseif (bloopx_starts_with($mType, 'audio/') || (isset($att['name']) && stripos((string)$att['name'], 'voice') !== false)) {
            $voiceAtt = $att;
        }
    }

    $voiceTranscript = '';
    if ($voiceAtt !== null) {
        $cleanB64 = bloopx_contains($voiceAtt['data'], ',') ? explode(',', $voiceAtt['data'], 2)[1] : $voiceAtt['data'];
        $aBytes = base64_decode($cleanB64, true);
        $aMime = explode(';', (string)$voiceAtt['mimeType'])[0];
        if ($aMime === 'video/webm') $aMime = 'audio/webm';
        if ($aBytes && strlen($aBytes) >= 100 && $hfToken !== '') {
            $wRes = bloopx_curl_request('https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3-turbo', [
                'method' => 'POST',
                'headers' => ['Authorization: Bearer ' . $hfToken, 'Content-Type: ' . $aMime],
                'body' => $aBytes,
                'timeout' => 14,
            ]);
            if ($wRes['ok']) {
                $wJson = @json_decode($wRes['body'], true);
                $voiceTranscript = trim((string)($wJson['text'] ?? ''));
            }
        }
    }

    $normalizedMessages = [];
    $msgCount = count($messages);
    foreach ($messages as $idx => $m) {
        if (!is_array($m)) continue;
        $role = (isset($m['role']) && $m['role'] === 'assistant') ? 'assistant' : 'user';
        $content = isset($m['content']) && is_string($m['content']) ? trim($m['content']) : '';
        if ($idx === $msgCount - 1 && $role === 'user' && $voiceTranscript !== '') {
            $content = $content !== '' ? "$content\n\n[Voice message]: $voiceTranscript" : $voiceTranscript;
        }
        if ($content !== '') {
            $normalizedMessages[] = ['role' => $role, 'content' => $content];
        }
    }

    if (empty($normalizedMessages)) {
        $normalizedMessages[] = [
            'role' => 'user',
            'content' => $voiceTranscript !== '' ? $voiceTranscript : 'Hello',
        ];
    }
    $recent = array_slice($normalizedMessages, -8);

    $systemMsg = [
        'role' => 'system',
        'content' => 'You are BloopX AI. Be concise, direct, helpful, and clear.',
    ];

    $openAiMessages = [$systemMsg];
    $recentCount = count($recent);
    foreach ($recent as $idx => $m) {
        if ($idx === $recentCount - 1 && $hasImages) {
            $parts = [['type' => 'text', 'text' => $m['content']]];
            foreach ($imageAtts as $img) {
                $parts[] = [
                    'type' => 'image_url',
                    'image_url' => ['url' => 'data:' . $img['mimeType'] . ';base64,' . $img['data']],
                ];
            }
            $openAiMessages[] = ['role' => $m['role'], 'content' => $parts];
        } else {
            $openAiMessages[] = $m;
        }
    }

    $diagnosticErrors = [];

    // Tier 1: xKiro SenseNova API
    if ($xkiroKey !== '') {
        $xRes = bloopx_call_xkiro_chat($xkiroEndpoint, $xkiroKey, $openAiMessages, $xkiroModel, $hasImages, 900, 0.7);
        if (!empty($xRes['ok']) && !empty($xRes['content'])) {
            bloopx_send_json(200, [
                'ok' => true,
                'content' => $xRes['content'],
                'voiceTranscript' => $voiceTranscript !== '' ? $voiceTranscript : null,
                'tokensUsed' => $xRes['tokensUsed'],
                'provider' => 'Xkiro (' . $xRes['model'] . ')',
            ]);
        }
        if (!empty($xRes['error'])) $diagnosticErrors[] = $xRes['error'];
    }

    // Tier 2: Hugging Face Router Chat API
    if ($hfToken !== '') {
        foreach (['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3'] as $hfModel) {
            $hfBody = json_encode([
                'model' => $hfModel,
                'messages' => array_merge([$systemMsg], $recent),
                'max_tokens' => 800,
                'temperature' => 0.7,
            ]);
            $hfRes = bloopx_curl_request($hfRouterEndpoint, [
                'method' => 'POST',
                'headers' => ['Content-Type: application/json', 'Authorization: Bearer ' . $hfToken],
                'body' => $hfBody,
                'timeout' => 16,
            ]);
            if ($hfRes['ok']) {
                $hfJson = @json_decode($hfRes['body'], true);
                $txt = bloopx_extract_text_from_choice($hfJson['choices'][0]['message']['content'] ?? '');
                if ($txt !== '') {
                    bloopx_send_json(200, [
                        'ok' => true,
                        'content' => $txt,
                        'voiceTranscript' => $voiceTranscript !== '' ? $voiceTranscript : null,
                        'tokensUsed' => (int)($hfJson['usage']['total_tokens'] ?? 120),
                        'provider' => 'HuggingFace (' . $hfModel . ')',
                    ]);
                }
            } else {
                $diagnosticErrors[] = "HF($hfModel) HTTP " . $hfRes['httpCode'];
                if ($hfRes['httpCode'] === 401 || $hfRes['httpCode'] === 403) break;
            }
        }
    }

    // Tier 3: Zero-key Pollinations OpenAI fallback (text only)
    if (!$hasImages && $voiceAtt === null) {
        $pRes = bloopx_curl_request('https://text.pollinations.ai/openai', [
            'method' => 'POST',
            'headers' => ['Content-Type: application/json'],
            'body' => json_encode([
                'model' => 'openai',
                'messages' => array_merge([$systemMsg], $recent),
                'max_tokens' => 750,
            ]),
            'timeout' => 12,
        ]);
        if ($pRes['ok']) {
            $pJson = @json_decode($pRes['body'], true);
            $txt = bloopx_extract_text_from_choice($pJson['choices'][0]['message']['content'] ?? '');
            if ($txt !== '') {
                bloopx_send_json(200, [
                    'ok' => true,
                    'content' => $txt,
                    'tokensUsed' => max(80, (int)ceil(strlen($txt) / 4)),
                    'provider' => 'pollinations-openai',
                ]);
            }
        } else {
            $diagnosticErrors[] = 'Fallback HTTP ' . $pRes['httpCode'];
        }
    }

    $hint = ($xkiroKey === '' && $hfToken === '')
        ? 'No API key configured. Paste your xKiro.com API key in php-config.php (recommended) or config.js.'
        : 'AI chat providers failed: ' . implode(' | ', $diagnosticErrors);

    bloopx_send_json(502, [
        'ok' => false,
        'error' => $hint,
        'httpStatus' => 502,
    ]);
}

// ============================================================================
// ACTION: HUGGING FACE VIDEO GENERATION (Start + Poll via PHP cURL)
// ============================================================================
$WAN_DEFAULT_SPACES = [
    [
        'spaceBase' => 'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
        'endpoint' => '/generate_video',
        'name' => 'Wan-AI/Wan2.2-T2V-A14B',
    ],
    [
        'spaceBase' => 'https://upsampler-wan-2-2-5b-video.hf.space',
        'endpoint' => '/generate_video',
        'name' => 'Wan-AI/Wan2.2-TI2V-5B',
    ],
    [
        'spaceBase' => 'https://yujiwang0606-rcm-wan.hf.space',
        'endpoint' => '/generate_videos',
        'name' => 'Wan-AI/Wan2.1-T2V-14B',
    ],
    [
        'spaceBase' => 'https://numanajmal0-wan-video-api.hf.space',
        'endpoint' => '/generate',
        'name' => 'Wan-AI/Wan2.1-T2V-1.3B',
    ],
];

$WAN_NEGATIVE_PROMPT = 'static, blurred details, subtitles, paintings, still picture, worst quality, low quality, ugly, deformed, camera zoom, ken burns effect, watermark, text, signature';

if ($action === 'video-start') {
    $prompt = isset($input['prompt']) && is_string($input['prompt']) ? trim($input['prompt']) : '';
    if ($prompt === '') {
        bloopx_send_json(400, ['ok' => false, 'error' => 'prompt is required for video generation.', 'httpStatus' => 400]);
    }

    $aspectRatio = isset($input['aspectRatio']) && in_array($input['aspectRatio'], ['16:9', '9:16', '1:1'], true)
        ? $input['aspectRatio']
        : '16:9';
    $duration = isset($input['duration']) && (int)$input['duration'] === 5 ? 5 : 10;
    $quality = isset($input['quality']) && in_array($input['quality'], ['480p', '720p', '1080p'], true)
        ? $input['quality']
        : '720p';
    $tierIndex = isset($input['tierIndex']) ? (int)$input['tierIndex'] : 0;
    if ($tierIndex < 0 || $tierIndex >= count($WAN_DEFAULT_SPACES)) {
        $tierIndex = 0;
    }

    $tierCfg = $WAN_DEFAULT_SPACES[$tierIndex];
    $spaceBase = $tierCfg['spaceBase'];
    if (isset($input['hfSpaceUrl']) && is_string($input['hfSpaceUrl'])) {
        $candSpace = rtrim(trim($input['hfSpaceUrl']), '/');
        if (bloopx_is_allowed_url($candSpace, [], ['.hf.space'])) {
            $spaceBase = $candSpace;
            if (bloopx_contains($candSpace, 'rcm-wan')) $tierCfg['endpoint'] = '/generate_videos';
            elseif (bloopx_contains($candSpace, 'wan-video-api')) $tierCfg['endpoint'] = '/generate';
            else $tierCfg['endpoint'] = '/generate_video';
        }
    }

    $framingText = $aspectRatio === '9:16'
        ? 'Cinematic real-world vertical 9:16 live-action video of'
        : ($aspectRatio === '1:1'
            ? 'Cinematic real-world 1:1 live-action video of'
            : 'Cinematic real-world 16:9 widescreen live-action video of');
    $wanPrompt = "$framingText $prompt, fluid natural 3D motion, continuous smooth movement, realistic physics, authentic 35mm cinema lighting, rich detail, sharp optical focus.";

    $seed = mt_rand(1, 2147483640);
    if (bloopx_contains($spaceBase, '5b-video')) {
        $wh = $aspectRatio === '9:16' ? [832, 480] : ($aspectRatio === '1:1' ? [640, 640] : [480, 832]);
        $payloadData = [null, $wanPrompt, $wh[0], $wh[1], $WAN_NEGATIVE_PROMPT, 5.0, 0, 4, $seed, true];
    } elseif (bloopx_contains($spaceBase, 'rcm-wan')) {
        $payloadData = [$wanPrompt, 'rCM-Wan2.1-T2V-14B-480p', 1, $aspectRatio === '9:16' ? '9:16' : '16:9', 80, 4, $seed];
    } elseif (bloopx_contains($spaceBase, 'wan-video-api')) {
        $wh = $aspectRatio === '9:16' ? [480, 832] : ($aspectRatio === '1:1' ? [640, 640] : [832, 480]);
        $payloadData = ['wan-base', $wanPrompt, $WAN_NEGATIVE_PROMPT, $wh[0], $wh[1], 49, 18, 5, -1, 1, null];
    } else {
        $wanAspect = $aspectRatio === '9:16' ? '9:16 (480x832)' : ($aspectRatio === '1:1' ? '1:1 (640x640)' : '16:9 (832x480)');
        $payloadData = [$wanPrompt, $wanAspect, 4, $WAN_NEGATIVE_PROMPT, 4.2, 1, 1, $seed, true];
    }

    $headers = ['Content-Type: application/json'];
    if ($hfToken !== '') {
        $headers[] = 'Authorization: Bearer ' . $hfToken;
    }

    $callUrl = $spaceBase . '/gradio_api/call' . $tierCfg['endpoint'];
    $postRes = bloopx_curl_request($callUrl, [
        'method' => 'POST',
        'headers' => $headers,
        'body' => json_encode(['data' => $payloadData]),
        'timeout' => 14,
    ]);

    if (!$postRes['ok']) {
        $isQuota = (bool)preg_match('/ZeroGPU quota|exceeded your.*quota/i', $postRes['body']);
        $snippet = bloopx_strip_html_snippet($postRes['body']);
        bloopx_send_json($postRes['httpCode'] >= 400 ? $postRes['httpCode'] : 502, [
            'ok' => false,
            'status' => 'error',
            'quotaExceeded' => $isQuota,
            'httpStatus' => $postRes['httpCode'],
            'error' => 'Hugging Face Space (' . $tierCfg['name'] . ') returned HTTP ' . $postRes['httpCode'] . ($snippet ? ': ' . $snippet : ($postRes['curlError'] ? ': ' . $postRes['curlError'] : '')),
        ]);
    }

    $postJson = @json_decode($postRes['body'], true);
    $eventId = isset($postJson['event_id']) && is_string($postJson['event_id']) ? trim($postJson['event_id']) : '';
    if ($eventId === '') {
        bloopx_send_json(502, [
            'ok' => false,
            'status' => 'error',
            'error' => 'Hugging Face Space did not return a Gradio event_id.',
            'detail' => bloopx_strip_html_snippet($postRes['body']),
            'httpStatus' => 502,
        ]);
    }

    bloopx_send_json(200, [
        'ok' => true,
        'status' => 'queued',
        'eventId' => $eventId,
        'spaceBase' => $spaceBase,
        'endpoint' => $tierCfg['endpoint'],
        'model' => $tierCfg['name'],
        'tierIndex' => $tierIndex,
        'duration' => $duration,
        'aspectRatio' => $aspectRatio,
        'quality' => $quality,
    ]);
}

if ($action === 'video-poll') {
    $eventId = isset($input['eventId']) && is_string($input['eventId']) ? preg_replace('/[^a-zA-Z0-9_-]/', '', $input['eventId']) : '';
    $spaceBase = isset($input['spaceBase']) && is_string($input['spaceBase']) ? rtrim(trim($input['spaceBase']), '/') : '';
    $endpoint = isset($input['endpoint']) && is_string($input['endpoint']) ? trim($input['endpoint']) : '/generate_video';

    if ($eventId === '' || !bloopx_is_allowed_url($spaceBase, [], ['.hf.space'])) {
        bloopx_send_json(400, ['ok' => false, 'error' => 'Valid eventId and allowlisted .hf.space URL are required.', 'httpStatus' => 400]);
    }
    if (!in_array($endpoint, ['/generate_video', '/generate_videos', '/generate'], true)) {
        $endpoint = '/generate_video';
    }

    $headers = [];
    if ($hfToken !== '') {
        $headers[] = 'Authorization: Bearer ' . $hfToken;
    }

    $sseUrl = $spaceBase . '/gradio_api/call' . $endpoint . '/' . $eventId;
    $sseRes = bloopx_curl_gradio_sse($sseUrl, $headers, 21);
    $sseText = $sseRes['text'];

    if ($sseRes['httpCode'] >= 400) {
        bloopx_send_json($sseRes['httpCode'], [
            'ok' => false,
            'status' => 'failed',
            'httpStatus' => $sseRes['httpCode'],
            'error' => 'Hugging Face video SSE stream returned HTTP ' . $sseRes['httpCode'] . ': ' . bloopx_strip_html_snippet($sseText),
        ]);
    }

    if (bloopx_contains($sseText, 'event: error')) {
        $isQuota = (bool)(
            preg_match('/ZeroGPU quota|exceeded your.*quota/i', $sseText) ||
            preg_match('/event:\s*error\s*\r?\n\s*data:\s*null\b/i', $sseText)
        );
        $errExtract = '';
        if (preg_match('/event:\s*error\s*\r?\n\s*data:\s*(.+)/i', $sseText, $em)) {
            $errExtract = trim($em[1]);
        }
        bloopx_send_json(502, [
            'ok' => false,
            'status' => 'failed',
            'quotaExceeded' => $isQuota,
            'error' => $isQuota
                ? 'Hugging Face ZeroGPU quota exceeded for this Space. Set a valid HF_TOKEN in php-config.php or config.js, or try again later.'
                : ('Hugging Face Space error: ' . ($errExtract !== '' && $errExtract !== 'null' ? bloopx_strip_html_snippet($errExtract) : 'Generation failed on worker.')),
        ]);
    }

    $rawVideoUrl = '';
    if (preg_match('/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i', $sseText, $um)) {
        $rawVideoUrl = bloopx_starts_with($um[1], 'http') ? $um[1] : ($spaceBase . '/gradio_api/file=' . ltrim($um[1], '/'));
    } elseif (preg_match('/"path"\s*:\s*"([^"]+\.mp4)"/i', $sseText, $pm)) {
        $rawVideoUrl = $spaceBase . '/gradio_api/file=' . ltrim($pm[1], '/');
    }

    if ($rawVideoUrl === '') {
        bloopx_send_json(504, [
            'ok' => false,
            'status' => 'timeout',
            'error' => 'Hugging Face Space did not finish within PHP cURL window (21s). Trying next video tier or please retry.',
            'detail' => $sseRes['curlError'] ?: bloopx_strip_html_snippet($sseText),
        ]);
    }

    $relStreamUrl = './generate.php?action=video-stream&u=' . rawurlencode($rawVideoUrl);
    bloopx_send_json(200, [
        'ok' => true,
        'status' => 'completed',
        'progress' => 100,
        'videoUrl' => $relStreamUrl,
        'directVideoUrl' => $rawVideoUrl,
        'provider' => 'HuggingFace-Wan',
    ]);
}

// ============================================================================
// ACTION: PHOTO GENERATION & PHOTO EDITING (xKiro SenseNova + HF / Spaces)
// ============================================================================
$prompt = isset($input['prompt']) && is_string($input['prompt']) ? trim($input['prompt']) : '';
if ($prompt === '') {
    bloopx_send_json(400, ['ok' => false, 'error' => 'prompt is required for photo generation.', 'httpStatus' => 400]);
}

$aspectRatio = isset($input['aspectRatio']) && in_array($input['aspectRatio'], ['1:1', '16:9', '9:16', '4:3', '3:4'], true)
    ? $input['aspectRatio']
    : '1:1';
$quality = isset($input['quality']) && in_array($input['quality'], ['standard', 'hd', 'ultra'], true)
    ? $input['quality']
    : 'hd';
list($fluxW, $fluxH) = bloopx_photo_dimensions($aspectRatio, $quality);

$sourceImage = isset($input['sourceImage']) && is_array($input['sourceImage']) ? $input['sourceImage'] : null;
$additionalImages = isset($input['additionalImages']) && is_array($input['additionalImages']) ? array_slice($input['additionalImages'], 0, 3) : [];
$upstreamErrors = [];

// Case A: Uploaded Photo Editing via xKiro Vision + HF Kontext / Qwen-Image-Edit / AI Horde
if ($sourceImage && !empty($sourceImage['data']) && is_string($sourceImage['data'])) {
    $srcMime = isset($sourceImage['mimeType']) && is_string($sourceImage['mimeType']) && bloopx_starts_with($sourceImage['mimeType'], 'image/')
        ? $sourceImage['mimeType']
        : 'image/jpeg';
    $cleanSrcB64 = bloopx_contains($sourceImage['data'], ',') ? explode(',', $sourceImage['data'], 2)[1] : $sourceImage['data'];
    $srcBytes = base64_decode($cleanSrcB64, true);
    if ($srcBytes === false || strlen($srcBytes) < 100) {
        bloopx_send_json(400, ['ok' => false, 'error' => 'Invalid sourceImage payload.', 'httpStatus' => 400]);
    }
    $srcDataUrl = "data:$srcMime;base64," . base64_encode($srcBytes);

    // Plan accurate scene edit via xKiro SenseNova Vision when key is set
    $editedPrompt = "Edited realistic 35mm DSLR photograph based on the reference image, $prompt, preserving the main subject identity, pose, and natural lighting cleanly";
    if ($xkiroKey !== '') {
        $visionMsg = [[
            'role' => 'user',
            'content' => [
                ['type' => 'text', 'text' => "You are a photo-editing prompt planner. Inspect the photo and write ONE concise 40-75 word description of the FINAL edited photo applying: \"$prompt\". Preserve unchanged subject, face, and background cleanly."],
                ['type' => 'image_url', 'image_url' => ['url' => $srcDataUrl]],
            ],
        ]];
        $xPlan = bloopx_call_xkiro_chat($xkiroEndpoint, $xkiroKey, $visionMsg, $xkiroModel, true, 160, 0.2);
        if (!empty($xPlan['directImageUrl'])) {
            bloopx_send_json(200, [
                'ok' => true,
                'imageUrl' => $xPlan['directImageUrl'],
                'prompt' => $prompt,
                'aspectRatio' => $aspectRatio,
                'quality' => $quality,
                'edited' => true,
                'provider' => 'Xkiro-SenseNova-Edit',
            ]);
        }
        if (!empty($xPlan['ok']) && !empty($xPlan['content'])) {
            $editedPrompt = trim($xPlan['content']);
        } elseif (!empty($xPlan['error'])) {
            $upstreamErrors[] = $xPlan['error'];
        }
    }

    // Tier 1 Edit: Hugging Face Inference Providers (when HF token configured)
    if ($hfToken !== '') {
        $hfEditEps = [
            [
                'name' => 'FLUX.1-Kontext',
                'url' => 'https://router.huggingface.co/fal-ai/fal-ai/flux-kontext/dev',
                'body' => ['prompt' => "$prompt. Keep unchanged areas faithful to the original image.", 'image_url' => $srcDataUrl, 'num_inference_steps' => 24, 'guidance_scale' => 2.5],
            ],
            [
                'name' => 'Qwen-Image-Edit',
                'url' => 'https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit',
                'body' => ['prompt' => $prompt, 'image_url' => $srcDataUrl, 'num_inference_steps' => 28],
            ],
            [
                'name' => 'FLUX-Img2Img',
                'url' => 'https://router.huggingface.co/fal-ai/fal-ai/flux/dev/image-to-image',
                'body' => ['prompt' => $editedPrompt, 'image_url' => $srcDataUrl, 'strength' => 0.58, 'num_inference_steps' => 24],
            ],
        ];
        foreach ($hfEditEps as $ep) {
            $eRes = bloopx_curl_request($ep['url'], [
                'method' => 'POST',
                'headers' => ['Content-Type: application/json', 'Authorization: Bearer ' . $hfToken],
                'body' => json_encode($ep['body']),
                'timeout' => 18,
            ]);
            if ($eRes['ok']) {
                if (bloopx_starts_with(strtolower($eRes['contentType']), 'image/') && strlen($eRes['body']) > 4000) {
                    bloopx_send_json(200, [
                        'ok' => true,
                        'imageUrl' => 'data:' . $eRes['contentType'] . ';base64,' . base64_encode($eRes['body']),
                        'prompt' => $prompt,
                        'aspectRatio' => $aspectRatio,
                        'quality' => $quality,
                        'edited' => true,
                        'provider' => $ep['name'],
                    ]);
                }
                $ej = @json_decode($eRes['body'], true);
                $b64Out = $ej['images'][0]['b64_json'] ?? $ej['data'][0]['b64_json'] ?? '';
                $urlOut = $ej['images'][0]['url'] ?? $ej['data'][0]['url'] ?? $ej['image']['url'] ?? '';
                if (is_string($b64Out) && strlen($b64Out) > 4000) {
                    bloopx_send_json(200, [
                        'ok' => true,
                        'imageUrl' => 'data:image/jpeg;base64,' . $b64Out,
                        'prompt' => $prompt,
                        'aspectRatio' => $aspectRatio,
                        'quality' => $quality,
                        'edited' => true,
                        'provider' => $ep['name'],
                    ]);
                }
                if (is_string($urlOut) && bloopx_is_allowed_url($urlOut, [], ['.fal.media', '.huggingface.co', '.hf.space'])) {
                    $imgGet = bloopx_curl_request($urlOut, ['timeout' => 12]);
                    if ($imgGet['ok'] && strlen($imgGet['body']) > 4000) {
                        bloopx_send_json(200, [
                            'ok' => true,
                            'imageUrl' => 'data:image/jpeg;base64,' . base64_encode($imgGet['body']),
                            'prompt' => $prompt,
                            'aspectRatio' => $aspectRatio,
                            'quality' => $quality,
                            'edited' => true,
                            'provider' => $ep['name'],
                        ]);
                    }
                }
            } else {
                $upstreamErrors[] = $ep['name'] . ' HTTP ' . $eRes['httpCode'];
            }
        }
    }

    // Tier 2 Edit: Gradio Kontext / Qwen-Image-Edit Spaces
    $tmpImg = @tempnam(sys_get_temp_dir(), 'bloopx_edit_');
    if ($tmpImg !== false) {
        @file_put_contents($tmpImg, $srcBytes);
        $editSpaces = [
            ['base' => 'https://black-forest-labs-flux-1-kontext-dev.hf.space', 'name' => 'FLUX.1-Kontext-Space', 'type' => 'kontext'],
            ['base' => 'https://multimodalart-qwen-image-edit-fast.hf.space', 'name' => 'Qwen-Image-Edit-Fast', 'type' => 'qwen-fast'],
        ];
        foreach ($editSpaces as $sp) {
            $upCh = curl_init($sp['base'] . '/gradio_api/upload');
            $cFile = new CURLFile($tmpImg, $srcMime, 'photo.jpg');
            curl_setopt($upCh, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($upCh, CURLOPT_POST, true);
            curl_setopt($upCh, CURLOPT_POSTFIELDS, ['files' => $cFile]);
            curl_setopt($upCh, CURLOPT_TIMEOUT, 12);
            curl_setopt($upCh, CURLOPT_SSL_VERIFYPEER, true);
            if ($hfToken !== '') {
                curl_setopt($upCh, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $hfToken]);
            }
            $upBody = curl_exec($upCh);
            $upCode = (int)curl_getinfo($upCh, CURLINFO_HTTP_CODE);
            curl_close($upCh);

            $uploadedArr = $upCode === 200 ? @json_decode($upBody ?: '', true) : null;
            if (!is_array($uploadedArr) || empty($uploadedArr[0])) {
                $upstreamErrors[] = $sp['name'] . ' upload HTTP ' . $upCode;
                continue;
            }
            $fileRef = ['path' => $uploadedArr[0], 'meta' => ['_type' => 'gradio.FileData']];
            $payloadData = $sp['type'] === 'kontext'
                ? [$fileRef, "$prompt. Preserve subject identity and lighting.", 0, true, 2.5, 24]
                : [$fileRef, $prompt, 0, true, 1.0, 8, true];

            $gHeaders = ['Content-Type: application/json'];
            if ($hfToken !== '') $gHeaders[] = 'Authorization: Bearer ' . $hfToken;

            $callRes = bloopx_curl_request($sp['base'] . '/gradio_api/call/infer', [
                'method' => 'POST',
                'headers' => $gHeaders,
                'body' => json_encode(['data' => $payloadData]),
                'timeout' => 10,
            ]);
            $callJson = $callRes['ok'] ? @json_decode($callRes['body'], true) : null;
            $evId = $callJson['event_id'] ?? '';
            if ($evId === '') {
                $upstreamErrors[] = $sp['name'] . ' call HTTP ' . $callRes['httpCode'];
                continue;
            }
            $sseRes = bloopx_curl_gradio_sse($sp['base'] . '/gradio_api/call/infer/' . $evId, $hfToken !== '' ? ['Authorization: Bearer ' . $hfToken] : [], 19);
            if (!bloopx_contains($sseRes['text'], 'event: error') && preg_match('/"url"\s*:\s*"([^"]+)"/', $sseRes['text'], $m)) {
                $resUrl = $m[1];
                if (bloopx_is_allowed_url($resUrl, [], ['.hf.space'])) {
                    $imgGet = bloopx_curl_request($resUrl, [
                        'headers' => $hfToken !== '' ? ['Authorization: Bearer ' . $hfToken] : [],
                        'timeout' => 12,
                    ]);
                    if ($imgGet['ok'] && strlen($imgGet['body']) > 4000) {
                        @unlink($tmpImg);
                        bloopx_send_json(200, [
                            'ok' => true,
                            'imageUrl' => 'data:image/webp;base64,' . base64_encode($imgGet['body']),
                            'prompt' => $prompt,
                            'aspectRatio' => $aspectRatio,
                            'quality' => $quality,
                            'edited' => true,
                            'provider' => $sp['name'],
                        ]);
                    }
                }
            } else {
                $upstreamErrors[] = $sp['name'] . ' SSE failed';
            }
        }
        @unlink($tmpImg);
    }

    bloopx_send_json(502, [
        'ok' => false,
        'error' => 'Photo editing failed: ' . (!empty($upstreamErrors) ? implode(' | ', $upstreamErrors) : 'Editing workers busy. Please try again.'),
        'httpStatus' => 502,
    ]);
}

// Case B: New Photo Generation (xKiro SenseNova Prompt Compiler + HF / FLUX / MagicStudio / AI Horde)
$compiledPrompt = "Unedited RAW 35mm DSLR photograph of " . preg_replace('/^(please\s+)?(generate|create|make|draw)\s+(a\s+|an\s+)?/i', '', $prompt);

if ($xkiroKey !== '') {
    $compilerMessages = [
        [
            'role' => 'system',
            'content' => 'You are a strict camera-realism prompt compiler. Convert the user request into ONE concise English description (35-60 words) for an authentic real-world DSLR photograph starting with: Unedited RAW 35mm DSLR photograph of',
        ],
        [
            'role' => 'user',
            'content' => $prompt,
        ],
    ];
    $xCompile = bloopx_call_xkiro_chat($xkiroEndpoint, $xkiroKey, $compilerMessages, $xkiroModel, false, 150, 0.15);
    if (!empty($xCompile['directImageUrl'])) {
        bloopx_send_json(200, [
            'ok' => true,
            'imageUrl' => $xCompile['directImageUrl'],
            'prompt' => $prompt,
            'aspectRatio' => $aspectRatio,
            'quality' => $quality,
            'provider' => 'Xkiro-SenseNova',
        ]);
    }
    if (!empty($xCompile['ok']) && !empty($xCompile['content'])) {
        $compiledPrompt = trim($xCompile['content'], "\"'` \t\n\r");
    } elseif (!empty($xCompile['error'])) {
        $upstreamErrors[] = $xCompile['error'];
    }
}

$fullPrompt = $compiledPrompt . ', Sony A7R V 50mm f/1.8 lens, natural ambient lighting, authentic documentary photography, crisp optical detail';

// Tier 1 Photo: Hugging Face Inference Providers (when HF token configured)
if ($hfToken !== '') {
    $hfEndpoints = [
        [
            'name' => 'HuggingFace-FLUX.1-schnell',
            'url' => 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell',
            'body' => ['prompt' => $fullPrompt, 'image_size' => ['width' => min($fluxW, 1024), 'height' => min($fluxH, 1024)], 'num_inference_steps' => 4],
        ],
        [
            'name' => 'HuggingFace-Qwen-Image',
            'url' => 'https://router.huggingface.co/fal-ai/fal-ai/qwen-image',
            'body' => ['prompt' => $fullPrompt, 'image_size' => ['width' => min($fluxW, 1024), 'height' => min($fluxH, 1024)]],
        ],
    ];
    foreach ($hfEndpoints as $ep) {
        $r = bloopx_curl_request($ep['url'], [
            'method' => 'POST',
            'headers' => ['Content-Type: application/json', 'Authorization: Bearer ' . $hfToken],
            'body' => json_encode($ep['body']),
            'timeout' => 16,
        ]);
        if ($r['ok']) {
            if (bloopx_starts_with(strtolower($r['contentType']), 'image/') && strlen($r['body']) > 4000) {
                bloopx_send_json(200, [
                    'ok' => true,
                    'imageUrl' => 'data:' . $r['contentType'] . ';base64,' . base64_encode($r['body']),
                    'prompt' => $prompt,
                    'compiledPrompt' => $compiledPrompt,
                    'aspectRatio' => $aspectRatio,
                    'quality' => $quality,
                    'provider' => $xkiroKey !== '' ? 'Xkiro-SenseNova-FLUX' : $ep['name'],
                ]);
            }
            $j = @json_decode($r['body'], true);
            $b64 = $j['images'][0]['b64_json'] ?? $j['data'][0]['b64_json'] ?? '';
            $u = $j['images'][0]['url'] ?? $j['data'][0]['url'] ?? $j['image']['url'] ?? '';
            if (is_string($b64) && strlen($b64) > 4000) {
                bloopx_send_json(200, [
                    'ok' => true,
                    'imageUrl' => 'data:image/jpeg;base64,' . $b64,
                    'prompt' => $prompt,
                    'compiledPrompt' => $compiledPrompt,
                    'aspectRatio' => $aspectRatio,
                    'quality' => $quality,
                    'provider' => $xkiroKey !== '' ? 'Xkiro-SenseNova-FLUX' : $ep['name'],
                ]);
            }
            if (is_string($u) && bloopx_is_allowed_url($u, [], ['.fal.media', '.huggingface.co', '.hf.space'])) {
                $imgGet = bloopx_curl_request($u, ['timeout' => 10]);
                if ($imgGet['ok'] && strlen($imgGet['body']) > 4000) {
                    bloopx_send_json(200, [
                        'ok' => true,
                        'imageUrl' => 'data:image/jpeg;base64,' . base64_encode($imgGet['body']),
                        'prompt' => $prompt,
                        'compiledPrompt' => $compiledPrompt,
                        'aspectRatio' => $aspectRatio,
                        'quality' => $quality,
                        'provider' => $xkiroKey !== '' ? 'Xkiro-SenseNova-FLUX' : $ep['name'],
                    ]);
                }
            }
        } else {
            $upstreamErrors[] = $ep['name'] . ' HTTP ' . $r['httpCode'];
        }
    }
}

// Tier 2 Photo: Gradio FLUX.1-schnell Space
$seed = mt_rand(1, 2147483640);
$fluxSteps = $quality === 'ultra' ? 6 : 4;
$gradioHeaders = ['Content-Type: application/json'];
if ($hfToken !== '') $gradioHeaders[] = 'Authorization: Bearer ' . $hfToken;

$fluxCall = bloopx_curl_request('https://black-forest-labs-flux-1-schnell.hf.space/gradio_api/call/infer', [
    'method' => 'POST',
    'headers' => $gradioHeaders,
    'body' => json_encode(['data' => [$fullPrompt, $seed, true, $fluxW, $fluxH, $fluxSteps]]),
    'timeout' => 10,
]);
$fluxJson = $fluxCall['ok'] ? @json_decode($fluxCall['body'], true) : null;
if (!empty($fluxJson['event_id'])) {
    $sse = bloopx_curl_gradio_sse(
        'https://black-forest-labs-flux-1-schnell.hf.space/gradio_api/call/infer/' . $fluxJson['event_id'],
        $hfToken !== '' ? ['Authorization: Bearer ' . $hfToken] : [],
        16
    );
    if (!bloopx_contains($sse['text'], 'event: error') && preg_match('/"url"\s*:\s*"([^"]+)"/', $sse['text'], $m)) {
        $imgUrl = $m[1];
        if (bloopx_is_allowed_url($imgUrl, [], ['.hf.space'])) {
            $imgGet = bloopx_curl_request($imgUrl, [
                'headers' => $hfToken !== '' ? ['Authorization: Bearer ' . $hfToken] : [],
                'timeout' => 10,
            ]);
            if ($imgGet['ok'] && strlen($imgGet['body']) > 4000) {
                bloopx_send_json(200, [
                    'ok' => true,
                    'imageUrl' => 'data:image/webp;base64,' . base64_encode($imgGet['body']),
                    'prompt' => $prompt,
                    'compiledPrompt' => $compiledPrompt,
                    'aspectRatio' => $aspectRatio,
                    'quality' => $quality,
                    'provider' => $xkiroKey !== '' ? 'Xkiro-SenseNova-FLUX' : 'FLUX.1-schnell',
                ]);
            }
        }
    } else {
        $upstreamErrors[] = 'FLUX.1-schnell Space busy';
    }
} else {
    $upstreamErrors[] = 'FLUX.1-schnell Space HTTP ' . $fluxCall['httpCode'];
}

// Tier 3 Photo: MagicStudio direct DSLR render
$magicForm = http_build_query([
    'prompt' => $fullPrompt,
    'output_format' => 'bytes',
    'user_profile_id' => 'null',
    'anonymous_user_id' => bin2hex(random_bytes(16)),
    'request_timestamp' => sprintf('%.3f', microtime(true)),
    'user_is_subscribed' => 'false',
    'client_id' => 'pSgX7WgjukXCBoYwDM8G8GLnRRkvAoJlqa5eAVvj95o',
]);
$magicRes = bloopx_curl_request('https://ai-api.magicstudio.com/api/ai-art-generator', [
    'method' => 'POST',
    'headers' => ['Origin: https://magicstudio.com', 'Referer: https://magicstudio.com/ai-art-generator/'],
    'body' => $magicForm,
    'timeout' => 15,
]);
if ($magicRes['ok'] && strlen($magicRes['body']) > 5000) {
    bloopx_send_json(200, [
        'ok' => true,
        'imageUrl' => 'data:image/jpeg;base64,' . base64_encode($magicRes['body']),
        'prompt' => $prompt,
        'compiledPrompt' => $compiledPrompt,
        'aspectRatio' => $aspectRatio,
        'quality' => $quality,
        'provider' => $xkiroKey !== '' ? 'Xkiro-SenseNova-DSLR' : 'MagicStudio-DSLR',
    ]);
} else {
    $upstreamErrors[] = 'MagicStudio HTTP ' . $magicRes['httpCode'];
}

bloopx_send_json(502, [
    'ok' => false,
    'error' => 'Photo generation failed: ' . implode(' | ', $upstreamErrors),
    'httpStatus' => 502,
]);
