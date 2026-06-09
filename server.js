/**
 * localtube — Full-stack YouTube to MP3/MP4 downloader.
 *
 * Server-side entry point. Express serves the frontend,
 * accepts conversion requests, spawns yt-dlp, and streams
 * real-time progress back to the client.
 */

import { spawn, spawnSync } from 'child_process';
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

// ── Dependency check at startup ────────────────────────────────────
function checkDependency(name) {
  const result = spawnSync('which', [name]);
  if (result.status !== 0) {
    console.error(`🚨 Missing dependency: ${name} is not installed.`);
    console.error(`   Install: pip3 install yt-dlp  (or: brew install yt-dlp)`);
    process.exit(1);
  }
  console.log(`  ✓ ${name} found`);
}

console.log('\n🔍 Checking dependencies...');
checkDependency('yt-dlp');
checkDependency('ffmpeg');

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
 * Returns structured progress JSON for real-time polling.
 * { percent, speed, eta, size, label }
 */
app.get('/api/progress', (_, res) => {
  try {
    const data = readFileSync(PROGRESS_FILE, 'utf-8').trim();
    if (!data) return res.json({ percent: 0, label: 'Preparing...' });
    try {
      const parsed = JSON.parse(data);
      return res.json(parsed);
    } catch {
      return res.json({ percent: 0, label: data });
    }
  } catch {
    res.json({ percent: 0, label: 'Processing...' });
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

  let proc;
  try {
    proc = spawn('yt-dlp', args, { timeout: 300000 });
  } catch (err) {
    writeFileSync(PROGRESS_FILE, '');
    return res.status(500).json({ error: 'Failed to start download process.' });
  }

  let stderrBuf = '';

  /**
   * Write structured progress to the progress file.
   * Shape: { percent, speed, eta, size, label }
   */
  function writeProgress(pct, speed, eta, size, label) {
    const data = JSON.stringify({ percent: pct, speed, eta, size, label });
    writeFileSync(PROGRESS_FILE, data);
  }

  // Parse yt-dlp's stdout for progress percentages / stage changes
  // Example line: [download] 45.2% of ~8.36MiB at 2.34MiB/s ETA 00:02
  proc.stdout.on('data', (data) => {
    const line = data.toString();
    const p = line.match(/\[download\]\s+(\d+\.?\d*)%/);
    if (p) {
      const pct = parseFloat(p[1]);
      const speedM = line.match(/at\s+([\d.]+[^\s]+)/);
      const etaM = line.match(/ETA\s+(\S+)/);
      const sizeM = line.match(/of\s+~?([\d.]+[^\s]+)/);
      writeProgress(
        pct,
        speedM ? speedM[1] : null,
        etaM ? etaM[1] : null,
        sizeM ? sizeM[1] : null,
        `Downloading... ${p[1]}%`,
      );
    } else if (line.includes('[ExtractAudio]') || line.includes('Converting')) {
      writeProgress(90, null, null, null, 'Converting audio...');
    } else if (line.includes('Merging')) {
      writeProgress(95, null, null, null, 'Merging video & audio...');
    }
  });

  // stderr fallback for progress (yt-dlp may log here in some modes)
  proc.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuf += text;
    const p = text.match(/(\d+\.?\d*)%/);
    if (p) {
      const pct = parseFloat(p[1]);
      writeProgress(pct, null, null, null, `Downloading... ${p[1]}%`);
    }
  });

  // Handle spawn error events (e.g., binary missing despite startup check)
  proc.on('error', (err) => {
    writeFileSync(PROGRESS_FILE, '');
    console.error('yt-dlp spawn error:', err.message);
    return res.status(500).json({ error: 'Download process encountered a system error.' });
  });

  proc.on('close', (code) => {
    writeFileSync(PROGRESS_FILE, '');

    if (code !== 0) {
      // Extract meaningful error message from stderr
      let msg;
      if (stderrBuf.includes('HTTP Error 403')) {
        msg = 'Video unavailable or age-restricted';
      } else if (stderrBuf.includes('Unable to extract')) {
        msg = 'Could not extract video info — private or deleted video?';
      } else if (stderrBuf.includes('Connection')) {
        msg = 'Network error — check your connection';
      } else {
        msg = 'Download failed. Try a different video or format.';
      }
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

    // Get file size for the response
    const filePath = join(DOWNLOADS_DIR, fileName);
    let fileSize = null;
    try {
      const bytes = statSync(filePath).size;
      if (bytes > 1024 * 1024) {
        fileSize = (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
      } else if (bytes > 1024) {
        fileSize = (bytes / 1024).toFixed(1) + ' KiB';
      } else {
        fileSize = bytes + ' B';
      }
    } catch {}

    cleanup();

    res.json({
      url: `/downloads/${encodeURIComponent(fileName)}`,
      title,
      ext: fileName.split('.').pop(),
      fileSize,
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`localtube running at http://localhost:${PORT}`);
});
