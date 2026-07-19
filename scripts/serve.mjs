#!/usr/bin/env node
/**
 * Minimal static server for local development — `npm run serve`.
 *
 * Exists because the widget fetches data/head.json, and fetch() is blocked on
 * file:// URLs. Opening index.html directly will silently degrade the widget,
 * which looks like a bug and isn't one.
 *
 * No dependencies. Not intended for anything but localhost.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let rel = url === '/' ? 'index.html' : url.slice(1);

    // The demo page requests ./trc-search.js at the site root; in the repo it
    // lives in dist/. Map it so local dev matches the deployed layout.
    if (rel === 'trc-search.js' || rel === 'trc-search.min.js') rel = `dist/${rel}`;

    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`\n  TRC widget dev server → http://localhost:${PORT}\n`);
  console.log('  Run `npm run build` first if you changed src/widget.js.\n');
});
