<?php
// BloopX Diagnostics & Health Check for InfinityFree / Apache Hosting
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");

$curlInstalled = function_exists('curl_version');
$curlDetails = $curlInstalled ? curl_version() : null;

$outboundTest = false;
if ($curlInstalled) {
    $ch = curl_init("https://api.xkiro.com/v1/models");
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 6);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Authorization: Bearer sk-xt-00f5e006f6e7a60050887fbcf1be7b600c79d8daf3ff86fd"]);
    $res = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $outboundTest = ($httpCode === 200);
}

echo json_encode([
    "status" => "ok",
    "name" => "BloopX InfinityFree PHP Bridge",
    "timestamp" => date('c'),
    "php_version" => phpversion(),
    "curl_enabled" => $curlInstalled,
    "curl_ssl_version" => $curlDetails ? $curlDetails['ssl_version'] : null,
    "outbound_ai_connectivity" => $outboundTest ? "connected" : "limited",
    "firestore_database" => "ai-studio-gutiaiplayground-aeb9da6e-3033-483f-a2ca-272cdb80d02c",
    "supported_features" => [
        "chat_completions",
        "photo_generation",
        "video_generation_relay",
        "firestore_sync"
    ]
], JSON_PRETTY_PRINT);
