<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$rawInput = file_get_contents("php://input");
$input = json_decode($rawInput, true);
$prompt = isset($input['prompt']) ? $input['prompt'] : '';

echo json_encode([
    "jobId" => "vjob_" . time() . "_" . bin2hex(random_bytes(3)),
    "status" => "processing",
    "progress" => 20,
    "prompt" => $prompt,
    "duration" => isset($input['duration']) ? (int)$input['duration'] : 5,
    "aspectRatio" => isset($input['aspectRatio']) ? $input['aspectRatio'] : "16:9",
    "quality" => isset($input['quality']) ? $input['quality'] : "720p"
]);
