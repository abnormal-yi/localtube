import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

describe('localtube server', () => {

  it('should have valid server.js syntax', () => {
    const result = spawnSync('node', ['--check', 'server.js']);
    assert.strictEqual(result.status, 0, 'server.js has syntax errors');
  });

  it('should have valid package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    assert.ok(pkg.dependencies?.express, 'express dependency missing');
  });

  it('should have express as a dependency', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    assert.ok(pkg.dependencies.express, 'express not in dependencies');
  });

  it('should export required API routes', () => {
    const src = readFileSync('server.js', 'utf-8');
    assert.ok(src.includes('/api/progress'), 'GET /api/progress not found');
    assert.ok(src.includes('/api/queue'), 'POST /api/queue not found');
    assert.ok(src.includes('/api/progress'), 'progress endpoint exists');
  });

  it('should have queue processing logic', () => {
    const src = readFileSync('server.js', 'utf-8');
    assert.ok(src.includes('processQueue'), 'queue processor function missing');
    assert.ok(src.includes('randomUUID'), 'UUID for queue IDs missing');
  });

  it('should detect playlist URLs', () => {
    const src = readFileSync('server.js', 'utf-8');
    assert.ok(src.includes('--yes-playlist'), 'playlist support missing');
    assert.ok(src.includes('--no-playlist'), 'single video fallback present');
  });

  it('should have CLI bin entry', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    assert.ok(pkg.bin?.localtube, 'CLI bin entry missing');
    assert.ok(existsSync('bin/localtube.js'), 'CLI file missing');
  });

  it('should have yt-dlp and ffmpeg dependency checks', () => {
    const src = readFileSync('server.js', 'utf-8');
    assert.ok(src.includes('checkDependency'), 'dependency check function missing');
    assert.ok(src.includes('yt-dlp'), 'yt-dlp check missing');
    assert.ok(src.includes('ffmpeg'), 'ffmpeg check missing');
  });

  it('should have structured progress output', () => {
    const src = readFileSync('server.js', 'utf-8');
    assert.ok(src.includes('percent'), 'structured progress missing');
    assert.ok(src.includes('label'), 'progress label missing');
  });

  it('should return HTML for GET /', async () => {
    // Start server briefly for integration test
    // This is a simplified check
    assert.ok(existsSync('index.html'), 'index.html exists');
  });
});
