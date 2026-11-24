<?php
/**
 * BloopX Server-Side PHP Secret Configuration (InfinityFree / Apache Shared Hosting)
 *
 * Paste your API keys below so generate.php attaches them strictly on the server side.
 * Keys placed here are NEVER exposed to browsers.
 * Direct browser access to this file is blocked via both PHP guard and .htaccess.
 */

if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'php-config.php') {
    http_response_code(403);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode([
        'ok' => false,
        'error' => 'Forbidden: php-config.php cannot be accessed directly.'
    ]);
    exit;
}

return [
    // Paste your xKiro.com API key here (recommended to keep it hidden from the browser)
    'XKIRO_API_KEY' => '',

    // xKiro SenseNova endpoint & default model
    'XKIRO_ENDPOINT' => 'https://api.xkiro.com/v1/chat/completions',
    'XKIRO_MODEL' => 'sensenova/sensenova-6.8-flash-lite',

    // Paste your Hugging Face Access Token here (used for Hugging Face Video & Image generation)
    'HF_TOKEN' => '',

    // Optional Gemini API key for audio transcription / multimodal chat fallback
    'GEMINI_API_KEY' => '',
];
