<?php
// BloopX AI Chat API Proxy for Apache / InfinityFree PHP Hosting
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

if (!isset($input['messages']) || !is_array($input['messages'])) {
    http_response_code(400);
    echo json_encode(["error" => "messages array is required"]);
    exit;
}

$apiKey = getenv("XKIRO_CHAT_API_KEY") ?: "sk-xt-00f5e006f6e7a60050887fbcf1be7b600c79d8daf3ff86fd";
$baseUrl = "https://api.xkiro.com/v1/chat/completions";

$models = [
    "mistralai/ministral-8b",
    "cohere/command-r7b-12-2024",
    "mistralai/ministral-14b",
    "sensenova/sensenova-6.8-flash-lite",
    "cohere/command-r-08-2024"
];

$normalizedMessages = [];
$normalizedMessages[] = [
    "role" => "system",
    "content" => "You are BloopX AI. Be concise, direct, helpful, and clear."
];

foreach ($input['messages'] as $m) {
    if (isset($m['content']) && is_string($m['content']) && trim($m['content']) !== '') {
        $normalizedMessages[] = [
            "role" => isset($m['role']) ? $m['role'] : "user",
            "content" => trim($m['content'])
        ];
    }
}

if (count($normalizedMessages) > 7) {
    $systemMsg = $normalizedMessages[0];
    $recent = array_slice($normalizedMessages, -6);
    $normalizedMessages = array_merge([$systemMsg], $recent);
}

$lastError = null;
foreach ($models as $model) {
    $payload = json_encode([
        "model" => $model,
        "messages" => $normalizedMessages,
        "max_tokens" => 800,
        "temperature" => 0.7
    ]);

    $ch = curl_init($baseUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Content-Type: application/json",
        "Authorization: Bearer " . $apiKey
    ]);
    curl_setopt($ch, CURLOPT_TIMEOUT, 20);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($httpCode === 200 && $response) {
        $resData = json_decode($response, true);
        $content = isset($resData['choices'][0]['message']['content']) ? $resData['choices'][0]['message']['content'] : '';
        if (!empty(trim($content))) {
            $tokensUsed = isset($resData['usage']['total_tokens']) ? (int)$resData['usage']['total_tokens'] : 90;
            echo json_encode([
                "content" => trim($content),
                "tokensUsed" => $tokensUsed,
                "provider" => $model
            ]);
            exit;
        }
    } else {
        $lastError = "Model $model returned HTTP $httpCode: $curlErr";
    }
}

http_response_code(500);
echo json_encode(["error" => "AI response failed: " . ($lastError ?: "Unable to reach AI services")]);
