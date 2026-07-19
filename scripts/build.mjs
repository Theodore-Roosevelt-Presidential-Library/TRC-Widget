#!/usr/bin/env node
/**
 * Bundle the widget into a single dependency-free file.
 *
 * The only real work here is inlining names.mjs. The widget needs the exact
 * same name-normalization the harvester uses — if the two ever drifted, typed
 * queries would stop matching the cached index in ways that would be very hard
 * to debug. Inlining at build time keeps one source of truth rather than a
 * hand-maintained copy in browser-land.
 *
 * Output: dist/trc-search.js (+ .min.js)
 * No dependencies. Node 18+.
 */

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Strip ESM export keywords so the module body works inside an IIFE. */
const deExport = (src) => src.replace(/^export\s+(function|const|let|class)\s/gm, '$1 ');

/**
 * Conservative minifier: comments and indentation only.
 *
 * Deliberately does NOT rename identifiers or restructure code — a clever
 * minifier without a test suite behind it is a liability, and the gzip win from
 * mangling is small compared to the risk. Strings and regexes are preserved by
 * tokenizing rather than regex-replacing blindly.
 */
function minify(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
        out += src[i++];
      }
      out += src[i++]; continue;
    }
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '\n') {
      out += '\n';
      i++;
      while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
      continue;
    }
    out += c; i++;
  }
  return out.replace(/\n{2,}/g, '\n').trim();
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  const names = deExport(await readFile(path.join(ROOT, 'scripts/names.mjs'), 'utf8'));
  const widget = await readFile(path.join(ROOT, 'src/widget.js'), 'utf8');
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  const banner = `/*! trc-search v${pkg.version} — Theodore Roosevelt Center digital library search
 *  https://github.com/mbriney/TRC-Widget — built ${new Date().toISOString().slice(0, 10)}
 *  No dependencies. Drop in a <script> tag and add <trc-search></trc-search>. */`;

  const bundle = `${banner}\n(function(){\n"use strict";\n${names}\n${widget}\n})();\n`;

  await mkdir(DIST, { recursive: true });
  await writeFile(path.join(DIST, 'trc-search.js'), bundle);

  const min = `${banner}\n(function(){"use strict";\n${minify(names)}\n${minify(widget)}\n})();\n`;
  await writeFile(path.join(DIST, 'trc-search.min.js'), min);

  // Sanity: the bundle must not still contain ESM syntax, which would throw in
  // a classic <script> tag.
  for (const [name, src] of [['bundle', bundle], ['minified', min]]) {
    if (/^\s*(export|import)\s/m.test(src)) throw new Error(`${name} still contains ESM syntax`);
    if (!src.includes('customElements.define')) throw new Error(`${name} lost its element definition`);
  }

  console.log(`  dist/trc-search.js      ${kb(bundle.length)}`);
  console.log(`  dist/trc-search.min.js  ${kb(min.length)}  (${kb(gzipSync(Buffer.from(min), { level: 9 }).length)} gzipped)`);
}

main().catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
