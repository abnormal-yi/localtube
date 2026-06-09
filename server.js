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
import { randomUUID } from 'crypto';
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

// ── Download queue ─────────────────────────────────────────────────
const queue = [];
let processing = false;

function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const item = queue.find(q => q.status === 'queued');
  if (!item) { processing = false; return; }
  item.status = 'processing';
  runDownload(item.url, item.format).then(result => {
    item.status = 'done';
    item.result = result;
    processing = false;
    processQueue();
  }).catch(err => {
    item.status = 'error';
    item.error = err.message;
    processing = false;
    processQueue();
  });
}

/**
 * Run a single yt-dlp download and return result metadata.
 * Handles both single videos and playlists.
 */
function runDownload(url, format) {
  return new Promise((resolve, reject) => {
    const isMp4 = format.startsWith('mp4');
    const ext = isMp4 ? 'mp4' : 'mp3';
    const timestamp = Date.now();
    const before = new Set(readdirSync(DOWNLOADS_DIR));

    const isPlaylist = url.includes('list=') || url.includes('/playlist?');

    const args = [
      isPlaylist ? '--yes-playlist' : '--no-playlist',
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
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    }

    args.push(url);

    let proc;
    try {
      proc = spawn('yt-dlp', args, { timeout: isPlaylist ? 600000 : 300000 });
    } catch (err) {
      return reject(new Error('Failed to start download process.'));
    }

    let stderrBuf = '';

    function writeProgress(pct, speed, eta, size, label) {
      const data = JSON.stringify({ percent: pct, speed, eta, size, label });
      writeFileSync(PROGRESS_FILE, data);
    }

    proc.stdout.on('data', (data) => {
      const line = data.toString();
      const p = line.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (p) {
        const pct = parseFloat(p[1]);
        const speedM = line.match(/at\s+([\d.]+[^\s]+)/);
        const etaM = line.match(/ETA\s+(\S+)/);
        const sizeM = line.match(/of\s+~?([\d.]+[^\s]+)/);
        writeProgress(pct, speedM ? speedM[1] : null, etaM ? etaM[1] : null, sizeM ? sizeM[1] : null, `Downloading... ${p[1]}%`);
      } else if (line.includes('[ExtractAudio]') || line.includes('Converting')) {
        writeProgress(90, null, null, null, 'Converting audio...');
      } else if (line.includes('Merging')) {
        writeProgress(95, null, null, null, 'Merging video & audio...');
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuf += text;
      const p = text.match(/(\d+\.?\d*)%/);
      if (p) {
        const pct = parseFloat(p[1]);
        writeProgress(pct, null, null, null, `Downloading... ${p[1]}%`);
      }
    });

    proc.on('error', (err) => {
      writeFileSync(PROGRESS_FILE, '');
      reject(new Error('Download process encountered a system error.'));
    });

    proc.on('close', (code) => {
      writeFileSync(PROGRESS_FILE, '');

      if (code !== 0) {
        let msg;
        if (stderrBuf.includes('HTTP Error 403')) msg = 'Video unavailable or age-restricted';
        else if (stderrBuf.includes('Unable to extract')) msg = 'Could not extract video info — private or deleted video?';
        else if (stderrBuf.includes('Connection')) msg = 'Network error — check your connection';
        else msg = 'Download failed. Try a different video or format.';
        return reject(new Error(msg));
      }

      const afterFiles = readdirSync(DOWNLOADS_DIR).filter(f => !before.has(f));
      if (afterFiles.length === 0) return reject(new Error('No output file found'));

      const files = afterFiles.map(fileName => {
        let title = fileName;
        title = title.substring(0, title.lastIndexOf('.'));
        title = title.replace(`-${timestamp}`, '').trim();
        title = title.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();

        const filePath = join(DOWNLOADS_DIR, fileName);
        let fileSize = null;
        try {
          const bytes = statSync(filePath).size;
          if (bytes > 1024 * 1024) fileSize = (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
          else if (bytes > 1024) fileSize = (bytes / 1024).toFixed(1) + ' KiB';
          else fileSize = bytes + ' B';
        } catch {}

        return {
          url: `/downloads/${encodeURIComponent(fileName)}`,
          title,
          ext: fileName.split('.').pop(),
          fileSize,
        };
      });

      cleanup();
      resolve(files.length === 1 ? files[0] : files);
    });
  });
}

// ── Queue API endpoints ─────────────────────────────────────────────
app.post('/api/queue', (req, res) => {
  const { url, format = 'mp3' } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  const id = randomUUID().slice(0, 8);
  queue.push({ id, url, format, status: 'queued', result: null, error: null });
  processQueue();
  res.json({ id, status: 'queued', position: queue.length });
});

app.get('/api/queue', (_, res) => {
  res.json(queue.map(item => ({
    id: item.id,
    url: item.url,
    format: item.format,
    status: item.status,
    result: item.status === 'done' ? item.result : null,
    error: item.status === 'error' ? item.error : null,
  })));
});

app.delete('/api/queue/:id', (req, res) => {
  const idx = queue.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (queue[idx].status === 'processing') return res.status(400).json({ error: 'Cannot cancel a running download' });
  queue.splice(idx, 1);
  res.json({ ok: true });
});

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



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`localtube running at http://localhost:${PORT}`);
});
