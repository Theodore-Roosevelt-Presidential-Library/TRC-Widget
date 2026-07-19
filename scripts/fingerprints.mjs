#!/usr/bin/env node
/**
 * Item-fingerprint harvester.
 *
 * Walks every item in the digital library and records only its taxonomy term
 * IDs — the "fingerprint". That's ~63 bytes per item, so the whole archive is
 * about 1,400 requests and 15 minutes, which is remarkably cheap for what it
 * unlocks:
 *
 *   1. The relationship graphs (who corresponded with whom, which subjects
 *      travel together) that the visualisation needs.
 *   2. Exact co-occurrence counts for *every* filter combination, precomputed —
 *      which removes the live scanning the search widget currently does against
 *      their flaky API.
 *
 * Output goes to .harvest-cache/fingerprints.jsonl (gitignored). It is
 * deliberately NOT committed: at ~8 MB refreshed weekly it would add hundreds of
 * megabytes to repo history within a year. The derived graph files are small and
 * are what gets committed. In CI the cache is restored between runs, so a
 * re-derivation normally costs nothing.
 *
 * Usage:
 *   node scripts/fingerprints.mjs              # full scan, resumable
 *   node scripts/fingerprints.mjs --limit 20   # first 20 pages, for testing
 *   node scripts/fingerprints.mjs --fresh      # ignore checkpoint
 *
 * No dependencies. Node 18+.
 */

import { appendFile, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.harvest-cache');
// Overridable so tests operate on their own file. They previously wrote
// synthetic rows to the real path; the next harvest appended to them and
// silently corrupted both graphs. Tests must not be able to reach this file.
const OUT = process.env.TRC_FINGERPRINTS || path.join(CACHE, 'fingerprints.jsonl');
const STATE = `${OUT.replace(/\.jsonl$/, '')}.state.json`;

const API = 'https://www.theodorerooseveltcenter.org/wp-json/wp/v2';
const PER_PAGE = 100;
const DELAY_MS = 250;
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 1000;
const USER_AGENT =
  'TRC-Widget-Harvester/1.0 (+https://github.com/mbriney/TRC-Widget) - caching public taxonomy data for an embeddable search widget';

/** Taxonomies we record, in fixed order. Index into this array is the key used
 *  in the JSONL rows, so the file stays compact. */
export const TAX = ['dl_creator', 'dl_recipient', 'dl_subject', 'dl_collection', 'dl_resource_type', 'dl_production_method'];

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const LIMIT = Number(opt('limit')) || 0;
const FRESH = flag('fresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function fetchWithRetry(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.ok) return res;
    if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
      const wait = BASE_BACKOFF_MS * 2 ** attempt;
      log(`  ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
      return fetchWithRetry(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  } catch (err) {
    if (attempt < MAX_RETRIES && !err.message.startsWith('HTTP ')) {
      const wait = BASE_BACKOFF_MS * 2 ** attempt;
      log(`  ${err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
      return fetchWithRetry(url, attempt + 1);
    }
    throw err;
  }
}

/**
 * Sort order matters more here than in the taxonomy harvest.
 *
 * A 1,400-page walk takes long enough that items can be added while we're
 * paginating. Default WordPress ordering is by date descending, so a new item
 * shifts everything down a slot and we'd silently skip one item per insertion.
 * Ordering by ID ascending makes the sequence stable: new items land at the end,
 * past where we've already read.
 */
const pageUrl = (page) =>
  `${API}/digital-library?per_page=${PER_PAGE}&page=${page}&orderby=id&order=asc&_fields=id,${TAX.join(',')}`;

async function loadState() {
  if (FRESH) return null;
  if (!existsSync(STATE)) return null;
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return null; }
}

async function main() {
  await mkdir(CACHE, { recursive: true });

  if (FRESH) { await rm(OUT, { force: true }); await rm(STATE, { force: true }); }

  const state = await loadState();
  let page = state?.nextPage ?? 1;
  let written = state?.written ?? 0;

  if (state) {
    log(`Resuming from page ${page} (${written.toLocaleString()} items already recorded)`);
  } else if (existsSync(OUT)) {
    // Starting from page 1 with no resume state means any existing output is
    // stale — a cancelled run, or a leftover test fixture. We append as we go,
    // so failing to truncate here silently concatenates two datasets and
    // corrupts every derived graph. Truncate explicitly.
    log('Existing fingerprint file has no resume state — starting clean');
    await writeFile(OUT, '');
  }

  const probe = await fetchWithRetry(`${API}/digital-library?per_page=1&_fields=id`);
  const total = Number(probe.headers.get('x-wp-total')) || 0;
  const totalPages = Math.ceil(total / PER_PAGE);
  const lastPage = LIMIT ? Math.min(LIMIT, totalPages) : totalPages;

  log(`${total.toLocaleString()} items across ${totalPages.toLocaleString()} pages${LIMIT ? ` (limited to ${lastPage})` : ''}`);
  const started = Date.now();

  let buffer = [];
  const flush = async () => {
    if (!buffer.length) return;
    await appendFile(OUT, buffer.join('\n') + '\n');
    buffer = [];
  };

  while (page <= lastPage) {
    let rows;
    try {
      const res = await fetchWithRetry(pageUrl(page));
      rows = await res.json();
    } catch (err) {
      if (err.message.includes('HTTP 400')) { log(`  page ${page} past end — stopping`); break; }
      await flush();
      await writeFile(STATE, JSON.stringify({ nextPage: page, written }));
      throw err;
    }

    if (!Array.isArray(rows) || !rows.length) { log(`  empty page ${page} — stopping`); break; }

    for (const it of rows) {
      // Compact positional form: [id, [creatorIds], [recipientIds], ...]
      buffer.push(JSON.stringify([it.id, ...TAX.map((t) => (Array.isArray(it[t]) ? it[t] : []))]));
      written++;
    }

    if (page % 10 === 0 || page === lastPage) {
      await flush();
      await writeFile(STATE, JSON.stringify({ nextPage: page + 1, written }));
      const pct = ((page / lastPage) * 100).toFixed(1);
      const rate = written / ((Date.now() - started) / 1000 || 1);
      const eta = Math.round(((lastPage - page) * PER_PAGE) / (rate || 1) / 60);
      log(`  ${page}/${lastPage} (${pct}%) — ${written.toLocaleString()} items, ~${eta} min left`);
    }

    page++;
    await sleep(DELAY_MS);
  }

  await flush();
  await writeFile(STATE, JSON.stringify({ nextPage: page, written, complete: page > lastPage }));

  const size = (await stat(OUT)).size;
  log(`Done — ${written.toLocaleString()} fingerprints, ${(size / 1024 / 1024).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)}s`);
}

/** Stream the fingerprint file back. Used by the graph builder. */
export async function* readFingerprints(file = OUT) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip a torn final line */ }
  }
}

export const FINGERPRINT_FILE = OUT;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('\nFingerprint harvest failed:', e.message);
    console.error('Progress is checkpointed — rerun to resume.');
    process.exit(1);
  });
}
