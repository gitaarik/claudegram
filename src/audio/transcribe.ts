import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';

const GROQ_WHISPER_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

/**
 * Transcribe an audio file using the Groq Whisper API directly via fetch.
 * No Python subprocess — much faster, especially on first call.
 */
export async function transcribeFile(filePath: string): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('model', GROQ_WHISPER_MODEL);
  formData.append('language', config.VOICE_LANGUAGE);
  formData.append('response_format', 'json');

  const response = await fetch(GROQ_WHISPER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`,
    },
    body: formData,
    signal: AbortSignal.timeout(config.VOICE_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Whisper API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = await response.json() as { text?: string };
  const transcript = (result.text || '').trim();

  if (!transcript) {
    throw new Error('Empty transcription result');
  }

  return transcript;
}

/**
 * Download a file from Telegram servers using curl (with retry).
 * Uses stdin config to avoid exposing bot token in process args.
 */
export function downloadTelegramAudio(
  botToken: string,
  filePath: string,
  destPath: string
): Promise<void> {
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  return new Promise((resolve, reject) => {
    // Use curl -K - to read URL from stdin, preventing token exposure in ps output
    const curlArgs = [
      '-sS', '-f',
      '--connect-timeout', '10',
      '--max-time', '30',
      '--retry', '2',
      '--retry-delay', '2',
      '-o', destPath,
      '-K', '-'  // Read config from stdin
    ];

    const child = spawn('curl', curlArgs, { timeout: 60_000 });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn curl: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = stderr.trim() || `curl exited with code ${code}`;
        reject(new Error(`Failed to download audio file: ${msg}`));
      }
    });

    // Write URL via stdin config format to avoid process arg exposure
    child.stdin.write(`url = "${fileUrl}"\n`);
    child.stdin.end();
  });
}
