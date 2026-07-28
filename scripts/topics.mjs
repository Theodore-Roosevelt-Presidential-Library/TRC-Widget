#!/usr/bin/env node
/**
 * Precompute per-subject resource-type breakdowns for <trc-topic>.
 *
 * For every subject, count how many of its items are Letters, Cartoons, Maps and
 * so on. The <trc-topic> widget embeds one subject by name and renders that
 * breakdown, each row deep-linking into the TRC's own search.
 *
 * All of this comes from the item fingerprints already on disk — no network.
 * Verified against the live site: subject "Conservation of natural resources"
 * has 10 cartoons here and `?subject=…&resource_type=Cartoon` returns 10 there.
 *
 * ── Sharding ────────────────────────────────────────────────────────────────
 *
 * The full set is ~960 KB gzipped across 40,000 subjects — far too much to load
 * for a single embedded topic. But a topic embed only ever needs *one* subject,
 * so the data is split by the first letter of the subject name into
 * data/topics/{a…z}.json. The widget normalises the embedded name, loads the one
 * matching shard (median ~43 KB, worst case ~110 KB, browser- and CDN-cached),
 * and looks the subject up inside it.
 *
 * Lookup is by normalised *name*, not slug: the widget is embedded with a
 * human-typed name, and TRC's slug rule has apostrophe edge cases we'd rather
 * not reproduce. The real slug is stored in the data so deep links stay exact.
 *
 * Usage: node scripts/topics.mjs      (or `npm run topics`)
 * No dependencies. Node 18+.
 */

import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFingerprints, FINGERPRINT_FILE, TAX } from './fingerprints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'topics');

const S = 1 + TAX.indexOf('dl_subject');
const RT = 1 + TAX.indexOf('dl_resource_type');

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Same normalisation the widget uses to resolve an embedded name to a subject. */
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function loadTerms(file) {
  const d = JSON.parse(await readFile(path.join(DATA, `${file}.json`), 'utf8'));
  return d.terms;
}

async function main() {
  if (!existsSync(FINGERPRINT_FILE)) {
    console.error('No fingerprints found. Run `npm run fingerprints` first.');
    process.exit(1);
  }

  const subjects = await loadTerms('subjects');
  const resourceTypes = await loadTerms('resource-types');

  const rtIndex = new Map(resourceTypes.map((t, i) => [t[0], i]));   // rt term id -> compact index
  const rtNames = resourceTypes.map((t) => t[1]);
  const subjMeta = new Map(subjects.map((t) => [t[0], { name: t[1], slug: t[2] }]));

  log('Tallying resource types per subject…');
  const breakdown = new Map();   // subject id -> Map(rtIndex -> count)
  let items = 0;

  for await (const row of readFingerprints()) {
    items++;
    const subs = row[S] || [];
    const types = row[RT] || [];
    if (!subs.length || !types.length) continue;
    for (const s of subs) {
      let m = breakdown.get(s);
      if (!m) { m = new Map(); breakdown.set(s, m); }
      for (const t of types) {
        const ti = rtIndex.get(t);
        if (ti != null) m.set(ti, (m.get(ti) || 0) + 1);
      }
    }
  }
  log(`Scanned ${items.toLocaleString()} items, ${breakdown.size.toLocaleString()} subjects with a typed item`);

  // Group subjects into first-letter shards.
  const shards = new Map();
  for (const [sid, m] of breakdown) {
    const meta = subjMeta.get(sid);
    if (!meta) continue;
    const key = norm(meta.name);
    if (!key) continue;
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);   // by count, widget re-limits
    const total = rows.reduce((a, r) => a + r[1], 0);

    const first = key[0];
    const shard = /[a-z]/.test(first) ? first : '_';
    (shards.get(shard) ?? shards.set(shard, {}).get(shard))[key] = {
      name: meta.name, slug: meta.slug, total, rt: rows,
    };
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const summary = [];
  for (const [shard, subs] of [...shards.entries()].sort()) {
    const payload = { resourceTypes: rtNames, subjects: subs };
    const json = JSON.stringify(payload);
    await writeFile(path.join(OUT, `${shard}.json`), json);
    summary.push({ shard, subjects: Object.keys(subs).length, kb: Math.round(json.length / 1024) });
  }

  // A tiny manifest so the widget can fail helpfully for a topic that isn't in
  // the archive at all, rather than 404-ing on a shard that doesn't exist.
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify({
    built: new Date().toISOString(),
    shards: summary.map((s) => s.shard),
    subjects: breakdown.size,
    resourceTypes: rtNames.length,
  }));

  log(`Wrote ${summary.length} shards to data/topics/`);
  console.table(summary);
}

main().catch((e) => { console.error('Topic build failed:', e.message); process.exit(1); });
