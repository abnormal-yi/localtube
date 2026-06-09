#!/usr/bin/env node

/**
 * localtube CLI — one-command launcher.
 *
 * Starts the server and opens the browser.
 * Usage: npx localtube   or   node bin/localtube.js
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const serverPath = join(__dirname, '..', 'server.js');

const server = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
});

const open =
  os.platform() === 'darwin'  ? 'open' :
  os.platform() === 'win32'   ? 'start' :
  'xdg-open';

setTimeout(() => {
  try {
    spawn(open, [`http://localhost:${PORT}`], { detached: true, stdio: 'ignore' });
  } catch {}
}, 2000);

process.on('SIGINT', () => { server.kill(); process.exit(); });
process.on('SIGTERM', () => { server.kill(); process.exit(); });
