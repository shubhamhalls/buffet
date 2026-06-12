import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });

const {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  DEFAULT_SPEECH_RATE = '-25%',
  PROCESSOR_TOKEN = '',
  PORT = '3000',
} = process.env;

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/voiceover', upload.single('video'), async (req, res) => {
  if (PROCESSOR_TOKEN) {
    const expected = `Bearer ${PROCESSOR_TOKEN}`;
    if (req.get('authorization') !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    res.status(500).json({ error: 'Azure Speech environment is not configured.' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'Missing multipart field "video".' });
    return;
  }

  const language = req.body.language || 'en-IN';
  const voice = req.body.voice || 'en-IN-NeerjaNeural';
  const rate = req.body.rate || DEFAULT_SPEECH_RATE;
  const wordPauseMs = Number.parseInt(req.body.wordPauseMs || '0', 10) || 0;

  const workDir = path.join(os.tmpdir(), `voiceover-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(workDir, { recursive: true });

  const inputVideo = req.file.path;
  const wavPath = path.join(workDir, 'original.wav');
  const ttsPath = path.join(workDir, 'female-voice.mp3');
  const outputVideo = path.join(workDir, 'female-voice-video.mp4');

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      inputVideo,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      wavPath,
    ]);

    const transcript = await transcribe(wavPath, language);
    if (!transcript.trim()) {
      throw new Error('Azure returned an empty transcript.');
    }

    await synthesize(transcript, ttsPath, language, voice, rate, wordPauseMs);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      inputVideo,
      '-i',
      ttsPath,
      '-c:v',
      'copy',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-shortest',
      outputVideo,
    ]);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Voiceover-Transcript', encodeURIComponent(transcript));

    createReadStream(outputVideo)
      .on('close', () => cleanup([inputVideo, workDir]))
      .pipe(res);
  } catch (error) {
    await cleanup([inputVideo, workDir]);
    res.status(500).json({ error: error.message || 'Voiceover failed.' });
  }
});

async function transcribe(wavPath, language) {
  const url = `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}`;
  const audio = await fs.readFile(wavPath);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      Accept: 'application/json',
    },
    body: audio,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Azure STT failed ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text);
  if (payload.RecognitionStatus !== 'Success') {
    throw new Error(`Azure STT failed: ${text}`);
  }

  return payload.DisplayText || '';
}

async function synthesize(text, outputPath, language, voice, rate, wordPauseMs) {
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const body = ssmlTextWithWordPauses(text, wordPauseMs);
  const ssml = `<speak version="1.0" xml:lang="${escapeXml(language)}"><voice xml:lang="${escapeXml(language)}" name="${escapeXml(voice)}"><prosody rate="${escapeXml(rate)}">${body}</prosody></voice></speak>`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'buffet-video-azure-voiceover',
    },
    body: ssml,
  });

  if (!response.ok) {
    throw new Error(`Azure TTS failed ${response.status}: ${await response.text()}`);
  }

  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

function ssmlTextWithWordPauses(text, pauseMs) {
  if (!pauseMs || pauseMs <= 0) {
    return escapeXml(text);
  }

  const safePauseMs = Math.max(0, Math.min(5000, pauseMs));

  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeXml)
    .join(`<break time="${safePauseMs}ms"/>`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function cleanup(paths) {
  await Promise.all(paths.map((item) => fs.rm(item, { recursive: true, force: true })));
}

app.listen(Number(PORT), () => {
  console.log(`Voiceover worker listening on ${PORT}`);
});
