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
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const names = deExport(await readFile(path.join(ROOT, 'scripts/names.mjs'), 'utf8'));
  const date = new Date().toISOString().slice(0, 10);

  await mkdir(DIST, { recursive: true });

  /**
   * Two independent bundles rather than one combined file. A site embedding only
   * the search box shouldn't download the graph code, and vice versa. Only the
   * search widget needs names.mjs inlined — the graph works from pre-labelled
   * nodes and has no query to normalise.
   */
  const targets = [
    { out: 'trc-search', src: 'src/widget.js', tag: 'trc-search', deps: names,
      desc: 'digital library search' },
    { out: 'trc-graph', src: 'src/graph.js', tag: 'trc-graph', deps: '',
      desc: 'digital library relationship map' },
  ];

  const rows = [];
  for (const t of targets) {
    const body = await readFile(path.join(ROOT, t.src), 'utf8');
    const banner = `/*! ${t.out} v${pkg.version} — Theodore Roosevelt Center ${t.desc}
 *  https://github.com/mbriney/TRC-Widget — built ${date}
 *  No dependencies. Drop in a <script> tag and add <${t.tag}></${t.tag}>. */`;

    const bundle = `${banner}\n(function(){\n"use strict";\n${t.deps}\n${body}\n})();\n`;
    const min = `${banner}\n(function(){"use strict";\n${t.deps ? minify(t.deps) : ''}\n${minify(body)}\n})();\n`;

    await writeFile(path.join(DIST, `${t.out}.js`), bundle);
    await writeFile(path.join(DIST, `${t.out}.min.js`), min);

    // ESM syntax would throw inside a classic <script> tag, and losing the
    // element definition would produce a bundle that loads and does nothing.
    for (const [label, src] of [['bundle', bundle], ['minified', min]]) {
      if (/^\s*(export|import)\s/m.test(src)) throw new Error(`${t.out} ${label} still contains ESM syntax`);
      if (!src.includes(`customElements.define('${t.tag}'`)) throw new Error(`${t.out} ${label} lost its <${t.tag}> definition`);
    }

    rows.push({ file: `${t.out}.min.js`, raw: kb(min.length), gzipped: kb(gzipSync(Buffer.from(min), { level: 9 }).length) });
    console.log(`  dist/${t.out}.js${' '.repeat(Math.max(1, 18 - t.out.length))}${kb(bundle.length)}`);
    console.log(`  dist/${t.out}.min.js${' '.repeat(Math.max(1, 14 - t.out.length))}${kb(min.length)}  (${kb(gzipSync(Buffer.from(min), { level: 9 }).length)} gzipped)`);
  }
}

main().catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
