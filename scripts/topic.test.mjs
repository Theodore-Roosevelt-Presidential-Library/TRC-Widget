/**
 * Headless render test for <trc-topic>.
 *
 * Drives the built bundle against the real topic shards in JSDOM: the widget
 * resolves an embedded subject name, renders the resource-type breakdown, and
 * builds deep links. Counts here are the same ones verified against the live
 * TRC (Conservation → 10 cartoons, Hunting → 71, Panama → 68 reports).
 *
 * Skips itself if jsdom isn't installed.
 *
 * Run: node --test scripts/topic.test.mjs
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* optional */ }

const BUNDLE = path.join(ROOT, 'dist/trc-topic.js');
const ready = JSDOM && existsSync(BUNDLE) && existsSync(path.join(ROOT, 'data/topics/c.json'));
const why = !JSDOM ? 'jsdom not installed' : 'run `npm run build` and `npm run topics` first';

let win, doc, bundle, shards;

before(async () => {
  if (!ready) return;
  bundle = await readFile(BUNDLE, 'utf8');
  shards = {};
  for (const s of ['c', 'h', 'p']) {
    shards[s] = await readFile(path.join(ROOT, `data/topics/${s}.json`), 'utf8');
  }
});

/** Mount a <trc-topic> with the given attributes and let it render. */
async function mount(attrs) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    runScripts: 'outside-only', url: 'https://trc.labs.trlibrary.com/',
  });
  win = dom.window;
  doc = win.document;
  const errors = [];
  win.addEventListener('error', (e) => errors.push(e.message));
  win.console.warn = (...a) => errors.push(a.join(' '));

  win.fetch = async (u) => {
    const m = /topics\/([a-z_])\.json/.exec(String(u));
    if (m && shards[m[1]]) return { ok: true, status: 200, json: async () => JSON.parse(shards[m[1]]) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  win.eval(bundle);
  const el = doc.createElement('trc-topic');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  doc.body.appendChild(el);
  await new Promise((r) => setTimeout(r, 60));
  return { el, sr: el.shadowRoot, errors };
}

const rows = (sr) => [...sr.querySelectorAll('a.row')].map((a) => ({
  label: a.querySelector('.label').textContent,
  count: a.querySelector('.c').textContent,
  href: a.getAttribute('href'),
  blank: a.getAttribute('target') === '_blank',
}));

test('renders a subject breakdown by resource type', { skip: !ready && why }, async () => {
  const { sr, errors } = await mount({ name: 'Conservation of natural resources' });
  assert.deepEqual(errors, [], errors.join(' | '));
  assert.match(sr.querySelector('h3').textContent, /Conservation of natural resources/);

  const r = rows(sr);
  assert.ok(r.length >= 5, `expected several formats, got ${r.length}`);
  // Ordered by count, descending.
  assert.equal(r[0].label, 'Letter');
  assert.equal(r[0].count, '222');
  const cartoon = r.find((x) => x.label === 'Cartoon');
  assert.equal(cartoon.count, '10', 'cartoon count must match the live-verified 10');
});

test('rows deep-link to the subject + resource-type search, in a new tab', { skip: !ready && why }, async () => {
  const { sr } = await mount({ name: 'Hunting' });
  const cartoon = rows(sr).find((x) => x.label === 'Cartoon');
  assert.ok(cartoon, 'no Cartoon row for Hunting');
  assert.equal(cartoon.count, '71', 'live-verified count');
  assert.match(cartoon.href, /[?&]subject=hunting(&|$)/);
  assert.match(cartoon.href, /[?&]resource_type=Cartoon(&|$)/);
  assert.ok(cartoon.blank, 'rows must open in a new tab');
});

test('name matching is case- and punctuation-insensitive', { skip: !ready && why }, async () => {
  const { sr } = await mount({ name: 'conservation of natural resources' });
  assert.match(sr.querySelector('h3').textContent, /Conservation of natural resources/,
    'lower-case name should still resolve');
});

test('limit caps the visible rows and reveals the rest on demand', { skip: !ready && why }, async () => {
  const { sr } = await mount({ name: 'Conservation of natural resources', limit: '4' });
  assert.equal(sr.querySelectorAll('a.row').length, 4, 'limit not applied');
  const more = sr.querySelector('.more');
  assert.ok(more, 'a limited list should offer "Show more"');
  more.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sr.querySelectorAll('a.row').length > 4, 'Show more did not expand the list');
});

test('a final link opens the whole subject, unfiltered', { skip: !ready && why }, async () => {
  const { sr } = await mount({ name: 'Panama' });
  const all = sr.querySelector('a.all');
  assert.ok(all, 'no "view all" link');
  assert.match(all.getAttribute('href'), /[?&]subject=panama(&|$)/);
  assert.ok(!/resource_type=/.test(all.getAttribute('href')), 'the view-all link must not be filtered');
  assert.equal(all.getAttribute('target'), '_blank');
});

test('an unknown topic fails helpfully rather than blank', { skip: !ready && why }, async () => {
  const { sr } = await mount({ name: 'Cryptozoology of the Moon' });
  assert.match(sr.textContent, /No subject named/);
  const link = sr.querySelector('a');
  assert.ok(link && /keyword=/.test(link.getAttribute('href')), 'should offer a keyword-search fallback');
});

test('the trlibrary theme is available and applies', { skip: !ready && why }, async () => {
  // Both themes render the same content; only the tokens change. Assert the
  // theme attribute is honoured and the trlibrary token block ships in the CSS.
  const { sr } = await mount({ name: 'Conservation of natural resources', theme: 'trlibrary' });
  assert.equal(sr.host.getAttribute('theme'), 'trlibrary');
  assert.ok(sr.querySelectorAll('a.row').length > 0, 'themed widget still renders its rows');

  const css = sr.querySelector('style').textContent;
  assert.match(css, /theme=trlibrary/, 'the trlibrary theme block must be in the widget CSS');
  assert.match(css, /#E7805D/, 'trlibrary coral token missing');
  assert.match(css, /Clearface/, 'trlibrary heading font missing');
});

test('the trlibrary-dark (green) theme is available and still functions', { skip: !ready && why }, async () => {
  // White-on-green for TRPL's editorial columns. Content and links must be
  // identical to any other theme — only the skin changes.
  const { sr } = await mount({ name: 'Conservation of natural resources', theme: 'trlibrary-dark', heading: 'off' });
  assert.equal(sr.host.getAttribute('theme'), 'trlibrary-dark');

  const rows = [...sr.querySelectorAll('a.row')];
  assert.ok(rows.length > 0, 'green-themed widget still lists formats');
  assert.ok(rows.every((a) => a.getAttribute('target') === '_blank'), 'rows still open in a new tab');
  assert.match(sr.querySelector('a.all').getAttribute('href'), /subject=conservation-of-natural-resources/);

  const css = sr.querySelector('style').textContent;
  assert.match(css, /\[theme=trlibrary-dark\][\s\S]*#1B4633/, 'the forest-green surface token must ship');
  assert.match(css, /\[theme=trlibrary-dark\]\)\s+h3[\s\S]*uppercase/, 'green heading should be uppercased');
  assert.match(css, /Dharma Gothic E/, 'green theme should declare the TRPL display font');
});
