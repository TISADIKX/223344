/**
 * BloopX Client Configuration (Static Shared Hosting / InfinityFree Compatible)
 *
 * No build-time environment variables (process.env / import.meta.env) are required.
 * Edit this file directly after uploading to your hosting `htdocs` folder.
 *
 * SECURITY TIP:
 * For maximum security on InfinityFree / PHP hosting, leave `xkiroApiKey` and `hfToken`
 * empty here and paste them into `php-config.php` instead so generate.php attaches
 * your keys strictly on the PHP server side (hidden from browser DevTools).
 * If you prefer quick setup and paste keys here, generate.php will still proxy
 * requests via PHP cURL to avoid CORS errors.
 */
window.BLOOPX_CONFIG = {
  // Relative path to the PHP backend proxy (works in root htdocs or subfolders)
  phpProxyUrl: './generate.php',

  // xKiro.com SenseNova Chat & Photo Endpoint Configuration
  xkiroEndpoint: 'https://api.xkiro.com/v1/chat/completions',
  xkiroModel: 'sensenova/sensenova-6.8-flash-lite',
  xkiroApiKey: '', // Optional: paste xKiro API key here, or keep hidden in php-config.php

  // Hugging Face Video & Image Inference Configuration
  hfToken: '', // Optional: paste Hugging Face token here, or keep hidden in php-config.php
  hfRouterEndpoint: 'https://router.huggingface.co/v1/chat/completions',
  hfVideoSpaces: [
    'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
    'https://upsampler-wan-2-2-5b-video.hf.space',
    'https://yujiwang0606-rcm-wan.hf.space',
    'https://numanajmal0-wan-video-api.hf.space',
  ],

  // Optional timeout for PHP shared-hosting cURL requests (ms)
  requestTimeoutMs: 28000,
};
