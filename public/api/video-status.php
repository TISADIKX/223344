<?php
/**
 * BloopX Video Status Endpoint for GoogieHost / PHP Hosting
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=UTF-8");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$jobId = isset($_GET['jobId']) ? preg_replace('/[^a-zA-Z0-9_-]/', '', $_GET['jobId']) : '';
if (empty($jobId)) {
    http_response_code(400);
    echo json_encode(["status" => "failed", "error" => "jobId is required"]);
    exit;
}

$tempFile = sys_get_temp_dir() . "/bloopx_vjob_" . $jobId . ".json";
if (!file_exists($tempFile)) {
    http_response_code(404);
    echo json_encode(["status" => "failed", "error" => "Job not found or expired"]);
    exit;
}

$jobData = json_decode(file_get_contents($tempFile), true);
$eventId = isset($jobData['eventId']) ? $jobData['eventId'] : null;
$spaceUrl = isset($jobData['spaceUrl']) ? $jobData['spaceUrl'] : 'https://upsampler-wan-2-2-14b-text-to-video.hf.space';
$createdAt = isset($jobData['createdAt']) ? (int)$jobData['createdAt'] : time();

if (!empty($jobData['videoUrl'])) {
    echo json_encode([
        "jobId" => $jobId,
        "status" => "completed",
        "progress" => 100,
        "videoUrl" => $jobData['videoUrl'],
        "duration" => isset($jobData['duration']) ? $jobData['duration'] : 10,
        "aspectRatio" => isset($jobData['aspectRatio']) ? $jobData['aspectRatio'] : '16:9',
        "quality" => isset($jobData['quality']) ? $jobData['quality'] : '720p'
    ]);
    exit;
}

// If running for more than 25 seconds, signal fallback to avoid 98% hang
$elapsed = time() - $createdAt;
if ($elapsed > 25) {
    echo json_encode([
        "jobId" => $jobId,
        "status" => "fallback",
        "progress" => 90,
        "duration" => isset($jobData['duration']) ? $jobData['duration'] : 10,
        "aspectRatio" => isset($jobData['aspectRatio']) ? $jobData['aspectRatio'] : '16:9',
        "quality" => isset($jobData['quality']) ? $jobData['quality'] : '720p'
    ]);
    exit;
}

// Quick non-blocking SSE status probe (max 3 seconds)
if ($eventId) {
    $sseUrl = $spaceUrl . "/gradio_api/call/generate_video/" . $eventId;
    $ch = curl_init($sseUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 3);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    $sseText = curl_exec($ch);
    curl_close($ch);

    if ($sseText) {
        if (preg_match('/"url":\s*"([^"]+\.mp4[^"]*)"/i', $sseText, $matches)) {
            $videoUrl = $matches[1];
            if (!str_starts_with($videoUrl, 'http')) {
                $videoUrl = $spaceUrl . "/gradio_api/file=" . $videoUrl;
            }
            $jobData['videoUrl'] = $videoUrl;
            $jobData['status'] = 'completed';
            $jobData['progress'] = 100;
            file_put_contents($tempFile, json_encode($jobData));

            echo json_encode([
                "jobId" => $jobId,
                "status" => "completed",
                "progress" => 100,
                "videoUrl" => $videoUrl,
                "duration" => isset($jobData['duration']) ? $jobData['duration'] : 10,
                "aspectRatio" => isset($jobData['aspectRatio']) ? $jobData['aspectRatio'] : '16:9',
                "quality" => isset($jobData['quality']) ? $jobData['quality'] : '720p'
            ]);
            exit;
        }
    }
}

// Calculate monotonic progress based on elapsed time
$progress = min(92, 20 + ($elapsed * 3));
$jobData['progress'] = $progress;
file_put_contents($tempFile, json_encode($jobData));

echo json_encode([
    "jobId" => $jobId,
    "status" => "processing",
    "progress" => $progress,
    "duration" => isset($jobData['duration']) ? $jobData['duration'] : 10,
    "aspectRatio" => isset($jobData['aspectRatio']) ? $jobData['aspectRatio'] : '16:9',
    "quality" => isset($jobData['quality']) ? $jobData['quality'] : '720p'
]);
