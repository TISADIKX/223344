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

$clientToken = isset($_SERVER['HTTP_X_HF_TOKEN']) ? trim($_SERVER['HTTP_X_HF_TOKEN']) : '';
$apiKey = $clientToken ?: (getenv("HF_ACCESS_TOKEN") ?: (getenv("HF_TOKEN") ?: ""));
$baseUrl = "https://router.huggingface.co/v1/chat/completions";

$models = [
    "meta-llama/Llama-3.3-70B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct",
    "deepseek-ai/DeepSeek-R1",
    "mistralai/Mistral-7B-Instruct-v0.3"
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
    $headers = ["Content-Type: application/json"];
    if (!empty($apiKey)) {
        $headers[] = "Authorization: Bearer " . $apiKey;
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
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

http_response_code(502);
echo json_encode([
    "error" => "AI chat service unavailable: " . ($lastError ?: "Unable to reach Hugging Face router") .
               (empty($apiKey) ? " (Tip: add your free Hugging Face token in Settings)." : "")
]);
