#!/usr/bin/env node
/**
 * Bundle the widgets into standalone, dependency-free files.
 *
 * Two independent bundles rather than one: a site embedding only the search box
 * shouldn't pay for the graph's D3 modules, and vice versa.
 *
 *   dist/trc-search.js   the <trc-search> element
 *   dist/trc-graph.js    the <trc-graph> element, with d3-force et al inlined
 *
 * D3 is bundled at build time rather than loaded from a CDN. An embeddable
 * widget that breaks when jsdelivr is blocked isn't embeddable, and plenty of
 * institutional networks block it.
 *
 * names.mjs is inlined into the search bundle so the browser and the harvester
 * share one definition of name normalisation. If those ever drifted, typed
 * queries would silently stop matching the cached index.
 *
 * Build-time deps only (esbuild, d3-*). The shipped files have none.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const TARGETS = [
  { out: 'trc-search', entry: 'src/widget.js', tag: 'trc-search', desc: 'digital library search' },
  { out: 'trc-graph', entry: 'src/graph.js', tag: 'trc-graph', desc: 'digital library relationship map' },
];

/**
 * The search widget imports nothing, but must still have names.mjs inlined.
 * Rather than special-casing the bundler, expose it as a virtual module the
 * entry point can import — one code path for both targets.
 */
const namesShim = {
  name: 'names-inline',
  setup(build) {
    build.onResolve({ filter: /^\.\/names\.mjs$/ }, () => ({
      path: path.join(ROOT, 'scripts/names.mjs'),
    }));
  },
};

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const date = new Date().toISOString().slice(0, 10);
  await mkdir(DIST, { recursive: true });

  for (const t of TARGETS) {
    const banner = `/*! ${t.out} v${pkg.version} — Theodore Roosevelt Center ${t.desc}
 *  https://github.com/mbriney/TRC-Widget — built ${date}
 *  No runtime dependencies. Add a <script> tag and a <${t.tag}> element. */`;

    const common = {
      entryPoints: [path.join(ROOT, t.entry)],
      bundle: true,
      format: 'iife',
      target: ['es2020'],
      legalComments: 'none',
      plugins: [namesShim],
      banner: { js: banner },
      write: false,
    };

    const dev = await esbuild.build({ ...common, minify: false });
    const min = await esbuild.build({ ...common, minify: true });

    const devSrc = dev.outputFiles[0].text;
    const minSrc = min.outputFiles[0].text;

    await writeFile(path.join(DIST, `${t.out}.js`), devSrc);
    await writeFile(path.join(DIST, `${t.out}.min.js`), minSrc);

    // A bundle that loads but defines no element is the failure mode most likely
    // to slip through — it throws nothing and does nothing.
    for (const [label, src] of [['bundle', devSrc], ['minified', minSrc]]) {
      if (!src.includes(t.tag)) throw new Error(`${t.out} ${label} lost its <${t.tag}> definition`);
      if (/^\s*export\s/m.test(src)) throw new Error(`${t.out} ${label} still contains ESM exports`);
    }

    const gz = gzipSync(Buffer.from(minSrc), { level: 9 }).length;
    console.log(`  dist/${t.out}.js`.padEnd(30) + kb(devSrc.length));
    console.log(`  dist/${t.out}.min.js`.padEnd(30) + `${kb(minSrc.length)}  (${kb(gz)} gzipped)`);
  }
}

main().catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
