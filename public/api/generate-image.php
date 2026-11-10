<?php
// BloopX AI Photo Generation API Proxy for Apache / InfinityFree PHP Hosting
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(["error" => "Method not allowed. Only POST requests are supported."]);
    exit;
}

$rawInput = file_get_contents("php://input");
$input = json_decode($rawInput, true);

$prompt = isset($input['prompt']) && is_string($input['prompt']) ? trim($input['prompt']) : '';
if (empty($prompt)) {
    http_response_code(400);
    echo json_encode(["error" => "prompt is required"]);
    exit;
}

$aspectRatio = isset($input['aspectRatio']) ? $input['aspectRatio'] : '1:1';
$quality = isset($input['quality']) ? $input['quality'] : 'hd';

$cleanPrompt = preg_replace('/^(please\s+)?(generate|create|make|draw)\s+(a\s+|an\s+)?/i', '', $prompt);
$fullPrompt = "Unedited RAW 35mm DSLR photograph of " . $cleanPrompt . ", captured on Sony A7R V 50mm f/1.8 lens, natural lighting, high detail";

// Tier 1: MagicStudio direct generator
$magicForm = http_build_query([
    'prompt' => $fullPrompt,
    'output_format' => 'bytes',
    'user_profile_id' => 'null',
    'anonymous_user_id' => bin2hex(random_bytes(16)),
    'request_timestamp' => sprintf("%.3f", microtime(true)),
    'user_is_subscribed' => 'false',
    'client_id' => 'pSgX7WgjukXCBoYwDM8G8GLnRRkvAoJlqa5eAVvj95o'
]);

$ch = curl_init('https://ai-api.magicstudio.com/api/ai-art-generator');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $magicForm);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    'Origin: https://magicstudio.com',
    'Referer: https://magicstudio.com/ai-art-generator/'
]);
curl_setopt($ch, CURLOPT_TIMEOUT, 18);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

$magicRes = curl_exec($ch);
$magicHttp = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($magicHttp === 200 && strlen($magicRes) > 8000) {
    $b64 = base64_encode($magicRes);
    echo json_encode([
        "imageUrl" => "data:image/jpeg;base64," . $b64,
        "prompt" => $prompt,
        "aspectRatio" => $aspectRatio,
        "quality" => $quality,
        "provider" => "MagicStudio-DSLR"
    ]);
    exit;
}

// Tier 2: Subnp multi-model relay
$subnpCh = curl_init('https://subnp.com/api/free/generate');
curl_setopt($subnpCh, CURLOPT_RETURNTRANSFER, true);
curl_setopt($subnpCh, CURLOPT_POST, true);
curl_setopt($subnpCh, CURLOPT_POSTFIELDS, json_encode(['prompt' => $fullPrompt, 'model' => 'flux-schnell']));
curl_setopt($subnpCh, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($subnpCh, CURLOPT_TIMEOUT, 15);
$subnpRes = curl_exec($subnpCh);
curl_close($subnpCh);

if ($subnpRes && preg_match('/"imageUrl"\s*:\s*"([^"]+)"/', $subnpRes, $matches)) {
    echo json_encode([
        "imageUrl" => $matches[1],
        "prompt" => $prompt,
        "aspectRatio" => $aspectRatio,
        "quality" => $quality,
        "provider" => "flux-schnell"
    ]);
    exit;
}

echo json_encode([
    "imageUrl" => null,
    "cooldown" => true
]);
