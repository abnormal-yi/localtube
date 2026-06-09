import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = join(os.homedir(), 'Downloads', 'yt-mp3');
const PROGRESS_FILE = join(__dirname, '.progress');
const MAX_FILES = 20;

if (!existsSync(DOWNLOADS_DIR)) {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use('/downloads', express.static(DOWNLOADS_DIR));

function cleanup() {
  const files = readdirSync(DOWNLOADS_DIR)
    .map(f => ({ name: join(DOWNLOADS_DIR, f), time: statSync(join(DOWNLOADS_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  while (files.length >= MAX_FILES) {
    const old = files.shift();
    try { unlinkSync(old.name); } catch {}
  }
}

app.get('/api/progress', (_, res) => {
  try {
    const data = readFileSync(PROGRESS_FILE, 'utf-8').trim();
    res.json({ progress: data || 'Preparing...' });
  } catch {
    res.json({ progress: 'Processing...' });
  }
});

app.post('/api/convert', (req, res) => {
  const { url, format = 'mp3' } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const isMp4 = format.startsWith('mp4');
  const ext = isMp4 ? 'mp4' : 'mp3';
  const timestamp = Date.now();
  const before = new Set(readdirSync(DOWNLOADS_DIR));

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
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push(url);

  const proc = spawn('yt-dlp', args, { timeout: 300000 });

  let stderrBuf = '';

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

    const afterFiles = readdirSync(DOWNLOADS_DIR).filter(f => !before.has(f));
    if (afterFiles.length === 0) {
      return res.status(500).json({ error: 'No output file found' });
    }

    const fileName = afterFiles[0];

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
