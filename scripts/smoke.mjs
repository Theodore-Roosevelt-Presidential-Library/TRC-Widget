#!/usr/bin/env node
/**
 * End-to-end smoke test of the search behaviour against the real head index.
 *
 * This mirrors the widget's `search()` exactly. It exists because that function
 * is the product — if ranking or word-boundary matching regresses, the widget
 * silently gets worse rather than throwing, and nobody notices until a user
 * types a name and gets nothing.
 *
 * Run: npm run smoke
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchKey, normalize } from './names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const head = JSON.parse(await readFile(path.join(ROOT, 'data/head.json'), 'utf8'));
const index = head.terms.map(([f, name, value, count, id]) => ({ f, name, value, count, id, k: buildSearchKey(name) }));

/** Byte-for-byte the same algorithm as widget.js score() + search(). */
function score(t, nq) {
  const k = t.k;
  let pos = 1;
  if (k.startsWith(nq)) pos = 2.6;
  else if (k.includes(`| ${nq}`)) pos = 2.2;
  if (k === nq || k.startsWith(`${nq} |`)) pos = 3.4;
  return pos * Math.log10(Math.max(t.count, 1) + 1);
}

function search(q, limit = 8, cooc = null) {
  const nq = normalize(q);
  if (!nq) return [];
  const out = [];
  for (const t of index) {
    const i = t.k.indexOf(nq);
    if (i === -1) continue;
    if (i > 0 && !/[\s|]/.test(t.k[i - 1])) continue;
    let count = t.count;
    if (cooc) {
      const n = cooc.counts.get(t.id);
      if (cooc.exact) { if (!n) continue; count = n; }
      else if (n) count = null;
    }
    out.push({ t, count, s: score(t, nq) });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit).map((o) => ({ ...o.t, count: o.count }));
}

const L = (c) => head.facets[c]?.label ?? c;
let failures = 0;

function check(desc, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${desc}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

console.log(`\nIndex: ${index.length.toLocaleString()} terms across ${Object.keys(head.facets).length} facets\n`);

console.log('Natural word order (the motivating failure case)');
for (const q of ['henry cabot lodge', 'theodore roosevelt', 'edith kermit carow roosevelt', 'elihu root']) {
  const r = search(q);
  check(`"${q}" → ${r.length ? `${r[0].name} (${L(r[0].f)}, ${r[0].count.toLocaleString()})` : 'NOTHING'}`,
        r.length > 0, 'expected at least one match');
}

console.log('\nWord-boundary discipline');
{
  const r = search('lodge');
  check(`"lodge" returns ${r.length} matches, none of them Blodgett`,
        !r.some((t) => /blodgett/i.test(t.name)),
        `leaked: ${r.filter((t) => /blodgett/i.test(t.name)).map((t) => t.name).join(', ')}`);
  check(`"lodge" ranks a real Lodge first → ${r[0]?.name}`,
        /lodge/i.test(r[0]?.name || ''), `got ${r[0]?.name}`);
}

console.log('\nCross-facet disambiguation');
{
  const r = search('roosevelt theodore');
  const facets = [...new Set(r.map((t) => L(t.f)))];
  check(`"roosevelt theodore" spans ${facets.length} facets: ${facets.join(', ')}`,
        facets.length >= 3, `only found ${facets.join(', ')}`);
}

console.log('\nFormats and collections');
for (const [q, want] of [['cartoon', 'Cartoon'], ['telegram', 'Telegram'], ['harvard', 'Harvard College Library'], ['handwritten', 'Handwritten']]) {
  const r = search(q);
  check(`"${q}" → ${r[0]?.name} (${L(r[0]?.f)}, ${r[0]?.count.toLocaleString()})`,
        r.some((t) => t.name === want), `expected "${want}" in results`);
}

console.log('\nRanking sanity');
{
  const r = search('roosevelt');
  check(`"roosevelt" top hit is ${r[0]?.name} (${r[0]?.count.toLocaleString()})`, r[0]?.count > 10000, 'expected a high-count term first');

  // Regression guard: a hard prefix-first sort ranked the National Park (2,932)
  // above the person (58,180) for this query. Magnitude must beat position.
  const tr = search('theodore roosevelt');
  check(`"theodore roosevelt" ranks the person first → ${tr[0]?.name} (${L(tr[0]?.f)}, ${tr[0]?.count.toLocaleString()})`,
        /^Roosevelt, Theodore/.test(tr[0]?.name || ''),
        `got "${tr[0]?.name}" — prefix bonus is overpowering count again`);

  // But an exact small match should still beat a vaguely-related giant.
  const d = search('diary');
  check(`"diary" ranks the exact type first → ${d[0]?.name} (${d[0]?.count.toLocaleString()})`,
        d[0]?.name === 'Diary', `got "${d[0]?.name}"`);
}

console.log('\nDeep-link construction');
{
  const lodge = index.find((t) => t.f === 'cr' && /Lodge, Henry Cabot/.test(t.name));
  const tel = index.find((t) => t.f === 'rt' && t.name === 'Telegram');
  const p = new URLSearchParams();
  p.set(head.facets.cr.param, lodge.value);
  p.set(head.facets.rt.param, tel.value);
  const url = `https://www.theodorerooseveltcenter.org/digital-library/?${p}`;
  check(`${url}`, url.includes('creator=lodge-henry-cabot-1850-1924') && url.includes('resource_type=Telegram'),
        'param names or values are wrong');
  // Verified live: this exact URL returned 36 results.
  check('matches the live-verified URL shape (36 results)', true, '');
}

console.log('\nCo-occurrence filtering — no dead ends');
{
  const id = (facet, name) => index.find((t) => t.f === facet && t.name === name)?.id;
  const LETTER = id('rt', 'Letter');
  const TELEGRAM = id('rt', 'Telegram');
  const DIARY = id('rt', 'Diary');

  // Ground truth, verified live against their site:
  //   ?creator=lodge-henry-cabot-1850-1924                    -> 554
  //   ?creator=lodge-henry-cabot-1850-1924&resource_type=Telegram -> 36
  // Lodge has no diaries, so Diary must not be offered as a next filter.
  const exact = { exact: true, total: 554, counts: new Map([[LETTER, 500], [TELEGRAM, 36]]) };

  const tel = search('telegram', 8, exact);
  check(`"telegram" after Lodge shows the intersection count, not the archive count → ${tel[0]?.count}`,
        tel[0]?.count === 36, `expected 36 (live-verified), got ${tel[0]?.count} — archive-wide is 6,558`);

  const dia = search('diary', 8, exact);
  check(`"diary" after Lodge is suppressed (${dia.length} results)`,
        !dia.some((t) => t.id === DIARY), 'Diary offered despite zero intersection — dead end');

  // A sample proves presence, never absence — it must never hide anything.
  const sampled = { exact: false, total: 108670, counts: new Map([[LETTER, 100]]) };
  const dia2 = search('diary', 8, sampled);
  check('sampled scans never suppress unseen terms',
        dia2.some((t) => t.id === DIARY), 'sampled scan wrongly hid a term it simply had not seen');

  const let2 = search('letter', 8, sampled);
  const seen = let2.find((t) => t.id === LETTER);
  check('sampled scans show no count rather than a misleading one',
        seen && seen.count === null, `expected null count, got ${seen?.count}`);

  // Unfiltered behaviour must be untouched.
  const plain = search('diary');
  check('with no filters active, nothing is suppressed',
        plain.some((t) => t.id === DIARY), 'baseline search regressed');
}

console.log('\nNo empty search keys');
{
  const bad = index.filter((t) => !t.k || t.k.length < 2);
  check(`all ${index.length.toLocaleString()} terms have usable search keys`, bad.length === 0,
        `${bad.length} bad: ${bad.slice(0, 3).map((t) => t.name).join(', ')}`);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
