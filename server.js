/**
 * localtube — Full-stack YouTube to MP3/MP4 downloader.
 *
 * Server-side entry point. Express serves the frontend,
 * accepts conversion requests, spawns yt-dlp, and streams
 * real-time progress back to the client.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import express from 'express';

// ── Paths & constants ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = join(os.homedir(), 'Downloads', 'yt-mp3');
const PROGRESS_FILE = join(__dirname, '.progress');
const MAX_FILES = 20;               // max cached downloads before cleanup

// Ensure the download directory exists on startup
if (!existsSync(DOWNLOADS_DIR)) {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ── Express setup ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname));              // serve frontend assets
app.use('/downloads', express.static(DOWNLOADS_DIR)); // serve completed files

// ── Auto-cleanup: keep only the newest MAX_FILES ──────────────────
function cleanup() {
  const files = readdirSync(DOWNLOADS_DIR)
    .map(f => ({ name: join(DOWNLOADS_DIR, f), time: statSync(join(DOWNLOADS_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  while (files.length >= MAX_FILES) {
    const old = files.shift();
    try { unlinkSync(old.name); } catch {}
  }
}

/**
 * GET /api/progress
 * Returns the current download progress for real-time polling.
 */
app.get('/api/progress', (_, res) => {
  try {
    const data = readFileSync(PROGRESS_FILE, 'utf-8').trim();
    res.json({ progress: data || 'Preparing...' });
  } catch {
    res.json({ progress: 'Processing...' });
  }
});

/**
 * POST /api/convert
 * Accepts { url, format } and spawns yt-dlp to download.
 *
 * Formats:
 *   mp3       — audio only, 192kbps
 *   mp4-720   — 720p HD video
 *   mp4-1080  — 1080p Full HD video
 *   mp4-1440  — 2K video
 *   mp4-2160  — 4K video
 */
app.post('/api/convert', (req, res) => {
  const { url, format = 'mp3' } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const isMp4 = format.startsWith('mp4');
  const ext = isMp4 ? 'mp4' : 'mp3';
  const timestamp = Date.now();
  const before = new Set(readdirSync(DOWNLOADS_DIR));

  // Build yt-dlp argument list
  const args = [
    '--no-playlist',
    '--newline',
    '--progress',
    '-o', join(DOWNLOADS_DIR, `%(title)s-${timestamp}.%(ext)s`),
  ];

  if (isMp4) {
    const qualityMap = {
      'mp4-720': '720', 'mp4-1080': '1080',
      'mp4-1440': '1440', 'mp4-2160': '2160',
    };
    const maxHeight = qualityMap[format] || '720';
    args.push(
      '-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`,
      '--merge-output-format', 'mp4',
    );
  } else {
    // MP3: extract audio at best quality
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push(url);

  const proc = spawn('yt-dlp', args, { timeout: 300000 });

  let stderrBuf = '';

  // Parse yt-dlp's stdout for progress percentages / stage changes
  proc.stdout.on('data', (data) => {
    const line = data.toString();
    const p = line.match(/\[download\]\s+(\d+\.\d+)%/);
    if (p) {
      writeFileSync(PROGRESS_FILE, `Downloading... ${p[1]}%`);
    } else if (line.includes('[ExtractAudio]') || line.includes('Converting')) {
      writeFileSync(PROGRESS_FILE, 'Converting audio...');
    } else if (line.includes('Merging')) {
      writeFileSync(PROGRESS_FILE, 'Merging video & audio...');
    }
  });

  // stderr fallback for progress (yt-dlp may log here in some modes)
  proc.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuf += text;
    const p = text.match(/(\d+\.\d+)%/);
    if (p) {
      writeFileSync(PROGRESS_FILE, `Downloading... ${p[1]}%`);
    }
  });

  proc.on('close', (code) => {
    writeFileSync(PROGRESS_FILE, '');

    if (code !== 0) {
      const msg = stderrBuf.slice(0, 300) || 'Unknown error';
      return res.status(500).json({ error: msg });
    }

    // Identify the newly created file by diffing the directory
    const afterFiles = readdirSync(DOWNLOADS_DIR).filter(f => !before.has(f));
    if (afterFiles.length === 0) {
      return res.status(500).json({ error: 'No output file found' });
    }

    const fileName = afterFiles[0];

    // Derive a clean title from the filename
    let title = fileName;
    title = title.substring(0, title.lastIndexOf('.'));
    title = title.replace(`-${timestamp}`, '').trim();
    title = title.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();

    cleanup();

    res.json({
      url: `/downloads/${encodeURIComponent(fileName)}`,
      title,
      ext: fileName.split('.').pop(),
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`localtube running at http://localhost:${PORT}`);
});
