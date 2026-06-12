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
  const mixedAudioPath = path.join(workDir, 'timestamped-voice.wav');
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

    const detailedTranscript = await transcribeDetailed(wavPath, language);
    const transcript = detailedTranscript.transcript;
    if (!transcript.trim()) {
      throw new Error('Azure returned an empty transcript.');
    }

    const videoDurationSeconds = await getMediaDurationSeconds(inputVideo);
    const phrases = stretchPhraseTimelineToVideo(
      groupWordsIntoPhrases(detailedTranscript.words),
      videoDurationSeconds,
    );

    if (phrases.length > 0) {
      await synthesizePhraseClips(phrases, workDir, language, voice, rate);
      await mixPhraseClips(phrases, videoDurationSeconds, mixedAudioPath);
    } else {
      await synthesize(transcript, ttsPath, language, voice, rate, wordPauseMs);
      await padAudioToDuration(ttsPath, videoDurationSeconds, mixedAudioPath);
    }

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      inputVideo,
      '-i',
      mixedAudioPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      String(videoDurationSeconds),
      '-metadata:s:v:0',
      'rotate=0',
      '-movflags',
      '+faststart',
      outputVideo,
    ]);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Voiceover-Transcript', encodeURIComponent(transcript));
    res.setHeader('X-Voiceover-Mode', phrases.length > 0 ? 'timestamped' : 'single-track-fallback');
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

async function transcribeDetailed(wavPath, language) {
  const url = `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;
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
    throw new Error(`Azure detailed STT failed ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text);
  if (payload.RecognitionStatus !== 'Success') {
    throw new Error(`Azure detailed STT failed: ${text}`);
  }

  const best = payload.NBest?.[0] || {};
  const transcript = best.Display || payload.DisplayText || '';
  const words = Array.isArray(best.Words) ? best.Words.map(normalizeAzureWord).filter(Boolean) : [];
  return { transcript, words };
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

async function synthesizePhraseClips(phrases, workDir, language, voice, rate) {
  for (const [index, phrase] of phrases.entries()) {
    const rawClipPath = path.join(workDir, `phrase-${String(index).padStart(3, '0')}-raw.mp3`);
    const fittedClipPath = path.join(workDir, `phrase-${String(index).padStart(3, '0')}.mp3`);
    phrase.clipPath = fittedClipPath;
    await synthesize(phrase.text, rawClipPath, language, voice, rate, 0);
    await fitAudioClipToDuration(rawClipPath, fittedClipPath, phrase.targetDurationSeconds);
  }
}

async function fitAudioClipToDuration(inputPath, outputPath, targetDurationSeconds) {
  const clipDurationSeconds = await getMediaDurationSeconds(inputPath);
  const targetDuration = Math.max(0.4, targetDurationSeconds || clipDurationSeconds);
  const tempo = clipDurationSeconds / targetDuration;
  const atempoFilter = buildAtempoFilter(tempo);
  const filters = [
    ...(atempoFilter ? [atempoFilter] : []),
    'apad',
    `atrim=0:${targetDuration}`,
  ];

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-filter:a',
    filters.join(','),
    outputPath,
  ]);
}

async function mixPhraseClips(phrases, durationSeconds, outputPath) {
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-t',
    String(durationSeconds),
    '-i',
    'anullsrc=channel_layout=mono:sample_rate=24000',
  ];

  for (const phrase of phrases) {
    args.push('-i', phrase.clipPath);
  }

  const filters = phrases.map((phrase, index) => {
    const inputIndex = index + 1;
    const delayMs = Math.max(0, Math.round(phrase.startSeconds * 1000));
    return `[${inputIndex}:a]adelay=${delayMs}|${delayMs}[a${inputIndex}]`;
  });

  const mixedInputs = ['[0:a]', ...phrases.map((_phrase, index) => `[a${index + 1}]`)].join('');
  filters.push(`${mixedInputs}amix=inputs=${phrases.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[aout]',
    '-t',
    String(durationSeconds),
    outputPath,
  );

  await execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 10 });
}

async function padAudioToDuration(inputAudioPath, durationSeconds, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    inputAudioPath,
    '-f',
    'lavfi',
    '-t',
    String(durationSeconds),
    '-i',
    'anullsrc=channel_layout=mono:sample_rate=24000',
    '-filter_complex',
    `[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=0:${durationSeconds}[aout]`,
    '-map',
    '[aout]',
    outputPath,
  ]);
}

async function getMediaDurationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);

  const duration = Number.parseFloat(stdout);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not read video duration with ffprobe.');
  }

  return duration;
}

function normalizeAzureWord(word) {
  const text = word.Word || word.word || '';
  const offset = Number(word.Offset ?? word.offset);
  const duration = Number(word.Duration ?? word.duration);

  if (!text || !Number.isFinite(offset) || !Number.isFinite(duration)) {
    return null;
  }

  return {
    text,
    startSeconds: offset / 10000000,
    durationSeconds: duration / 10000000,
  };
}

function groupWordsIntoPhrases(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  const phrases = [];
  let current = [];

  for (const word of words) {
    const previous = current[current.length - 1];
    const currentStart = current[0]?.startSeconds ?? word.startSeconds;
    const previousEnd = previous ? previous.startSeconds + previous.durationSeconds : word.startSeconds;
    const gap = word.startSeconds - previousEnd;
    const phraseDuration = word.startSeconds + word.durationSeconds - currentStart;

    if (current.length > 0 && (gap > 0.8 || current.length >= 5 || phraseDuration > 3.5)) {
      phrases.push(buildPhrase(current));
      current = [];
    }

    current.push(word);
  }

  if (current.length > 0) {
    phrases.push(buildPhrase(current));
  }

  return withPhraseTargetDurations(phrases.filter((phrase) => phrase.text));
}

function buildPhrase(words) {
  const first = words[0];
  const last = words[words.length - 1];

  return {
    text: words.map((word) => word.text).join(' '),
    startSeconds: first.startSeconds,
    endSeconds: last.startSeconds + last.durationSeconds,
  };
}

function withPhraseTargetDurations(phrases) {
  return phrases.map((phrase, index) => {
    const nextPhrase = phrases[index + 1];
    const originalDuration = Math.max(0.4, phrase.endSeconds - phrase.startSeconds);
    const availableWindow = nextPhrase
      ? Math.max(originalDuration, nextPhrase.startSeconds - phrase.startSeconds - 0.15)
      : originalDuration;
    const targetDurationSeconds = Math.min(
      Math.max(originalDuration, Math.min(availableWindow, 3.5)),
      5,
    );

    return { ...phrase, targetDurationSeconds };
  });
}

function stretchPhraseTimelineToVideo(phrases, videoDurationSeconds) {
  if (!phrases.length || !Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
    return phrases;
  }

  const firstStart = phrases[0].startSeconds;
  const lastEnd = phrases[phrases.length - 1].endSeconds;
  const spokenSpan = Math.max(0.1, lastEnd - firstStart);
  const targetEnd = Math.max(firstStart + spokenSpan, videoDurationSeconds - 1);

  if (lastEnd >= videoDurationSeconds * 0.85) {
    return phrases;
  }

  const stretch = Math.min(3, (targetEnd - firstStart) / spokenSpan);
  const stretched = phrases.map((phrase) => {
    const startSeconds = firstStart + (phrase.startSeconds - firstStart) * stretch;
    const endSeconds = firstStart + (phrase.endSeconds - firstStart) * stretch;

    return {
      ...phrase,
      startSeconds,
      endSeconds,
    };
  });

  return withPhraseTargetDurations(stretched);
}

function buildAtempoFilter(tempo) {
  if (!Number.isFinite(tempo) || tempo <= 0 || Math.abs(tempo - 1) < 0.03) {
    return '';
  }

  const parts = [];
  let remaining = tempo;

  while (remaining < 0.5) {
    parts.push('atempo=0.5');
    remaining /= 0.5;
  }

  while (remaining > 2) {
    parts.push('atempo=2');
    remaining /= 2;
  }

  parts.push(`atempo=${remaining.toFixed(3)}`);
  return parts.join(',');
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
