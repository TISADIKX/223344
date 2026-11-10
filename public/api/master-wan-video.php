<?php
/**
 * BloopX Video Master Endpoint for GoogieHost / PHP Hosting
 * Immediately passes through raw video clip without requiring ffmpeg binary
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$rawInput = file_get_contents('php://input');
$data = json_decode($rawInput, true);

$rawVideoUrl = isset($data['rawVideoUrl']) ? trim((string)$data['rawVideoUrl']) : '';

if (!empty($rawVideoUrl)) {
    echo json_encode([
        "videoUrl" => $rawVideoUrl,
        "status" => "completed",
        "progress" => 100
    ]);
} else {
    http_response_code(400);
    echo json_encode(["error" => "rawVideoUrl is required"]);
}
