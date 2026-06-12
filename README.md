# Azure Voiceover Worker

Use this when Hostinger does not have `ffmpeg`.

Hostinger uploads the video to this worker, the worker creates the Azure female voiceover, then it returns a finished MP4 for Hostinger to send to Bunny.

## Deploy

Deploy this folder to a host that supports Docker, such as Azure App Service for Containers, Render, Railway, or a small VPS.

Environment variables:

```bash
AZURE_SPEECH_KEY=your-azure-speech-key
AZURE_SPEECH_REGION=eastus
PROCESSOR_TOKEN=choose-a-long-random-password
PORT=3000
```

The endpoint Hostinger needs is:

```text
https://your-worker-domain.example.com/voiceover
```

## Hostinger Config

In `config.php`:

```php
$voiceover_processor_url = 'https://your-worker-domain.example.com/voiceover';
$voiceover_processor_token = 'same-long-random-password';
$azure_speech_voice = 'en-US-JennyNeural';
```

With `$voiceover_processor_url` set, Hostinger no longer needs local `ffmpeg`.
