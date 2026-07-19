/**
 * Headless render test for <trc-graph>.
 *
 * Loads the *built bundle* against the *real graph data* in a JSDOM document and
 * drives it the way a visitor would: initial render, click to expand, switch
 * modes. Everything else in this project tests data or pure functions; this is
 * the only check that the shipped file actually works in a DOM.
 *
 * It earned its place immediately — it caught the people graph reporting TR's
 * recipient count (30,656) beside a link returning his creator count (58,180).
 * No data-level test would have seen that, because both numbers were correct in
 * isolation. It only looked wrong on screen, together.
 *
 * JSDOM has no layout engine, so getBoundingClientRect is stubbed and the force
 * simulation runs against fixed dimensions. That verifies wiring, not visual
 * quality — a real browser is still the final word on whether it looks good.
 *
 * Skips itself if jsdom isn't installed, so `npm test` works without it.
 *
 * Run: node --test scripts/render.test.mjs
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

const BUNDLE = path.join(ROOT, 'dist/trc-graph.js');
const ready = JSDOM && existsSync(BUNDLE);
const why = !JSDOM ? 'jsdom not installed' : 'run `npm run build` first';

let win, el, sr, errors;

/** Build a JSDOM document with the widget mounted and the simulation settled. */
async function mount(attrs = {}) {
  const graphs = {
    people: await readFile(path.join(ROOT, 'data/graph-people.json'), 'utf8'),
    subjects: await readFile(path.join(ROOT, 'data/graph-subjects.json'), 'utf8'),
  };
  const bundle = await readFile(BUNDLE, 'utf8');

  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://trc.labs.trlibrary.com/',
  });
  const { window } = dom;
  errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.console.warn = (...a) => errors.push(`warn: ${a.join(' ')}`);

  window.fetch = async (u) => ({
    ok: true, status: 200,
    json: async () => JSON.parse(String(u).includes('subjects') ? graphs.subjects : graphs.people),
  });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  // No layout engine in JSDOM; the widget reads the stage size from here.
  window.Element.prototype.getBoundingClientRect = () => (
    { width: 680, height: 460, top: 0, left: 0, right: 680, bottom: 460 });

  window.eval(bundle);
  const node = window.document.createElement('trc-graph');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  window.document.body.appendChild(node);
  await new Promise((r) => setTimeout(r, 900));
  return { window, el: node, sr: node.shadowRoot };
}

const click = (target) => target.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 500));

before(async () => {
  if (!ready) return;
  ({ window: win, el, sr } = await mount());
});

test('the built bundle renders without errors', { skip: !ready && why }, () => {
  assert.deepEqual(errors, [], `console/runtime errors: ${errors.join(' | ')}`);
  assert.ok(sr.querySelector('svg'), 'no svg');
});

test('opens on Roosevelt with nodes and edges drawn', { skip: !ready && why }, () => {
  assert.ok(sr.querySelectorAll('g.node').length >= 5, 'too few nodes rendered');
  assert.ok(sr.querySelectorAll('line.edge').length >= 5, 'too few edges rendered');
  assert.match(sr.querySelector('.panel h3').textContent, /^Roosevelt, Theodore/);
});

test('the force simulation actually positions nodes', { skip: !ready && why }, () => {
  const transforms = [...sr.querySelectorAll('g.node')].map((n) => n.getAttribute('transform'));
  assert.ok(transforms.every((t) => /translate\([-\d.]+,\s*[-\d.]+\)/.test(t || '')),
    'nodes have no transform — the simulation never ticked');
  // Distinct positions: a collapsed layout would stack them all at one point.
  assert.ok(new Set(transforms).size > 3, 'nodes are stacked on top of each other');
});

test('node counts agree with the searches they link to', { skip: !ready && why }, () => {
  // The regression this file was written for. TR is both a creator (58,180) and
  // a recipient (30,656); showing one total beside a single-role link misreports
  // the archive. Each role gets its own link and its own count.
  const links = [...sr.querySelectorAll('.panel a')];
  assert.equal(links.length, 2, `expected separate creator and recipient links, got ${links.length}`);

  const wrote = links.find((a) => /Wrote/.test(a.textContent));
  const received = links.find((a) => /Received/.test(a.textContent));
  assert.ok(wrote && received, 'missing a role link');

  assert.match(wrote.getAttribute('href'), /[?&]creator=/, '"Wrote" must link to a creator search');
  assert.match(received.getAttribute('href'), /[?&]recipient=/, '"Received" must link to a recipient search');

  // Live-verified against theodorerooseveltcenter.org.
  assert.match(wrote.textContent, /58,180/, `wrote count wrong: ${wrote.textContent}`);
  assert.match(received.textContent, /30,656/, `received count wrong: ${received.textContent}`);
});

test('clicking a neighbour expands the map and records the path', { skip: !ready && why }, async () => {
  const before = sr.querySelectorAll('g.node').length;
  const other = [...sr.querySelectorAll('g.node')].find((g) => !g.classList.contains('sel'));
  assert.ok(other, 'no unselected node to click');
  click(other);
  await settle();

  assert.ok(sr.querySelectorAll('g.node').length > before, 'clicking did not reveal new nodes');
  assert.match(sr.querySelector('.crumb').textContent, /→/,
    'breadcrumb should show the path taken from Roosevelt');
  assert.ok(!sr.querySelector('.reset').hidden, '"Start over" should appear once the user has navigated');
});

test('switching to subjects loads the other graph', { skip: !ready && why }, async () => {
  click(sr.querySelector('[data-mode=subjects]'));
  await new Promise((r) => setTimeout(r, 900));

  assert.ok(sr.querySelectorAll('g.node').length >= 5, 'subject graph did not render');
  const link = sr.querySelector('.panel a');
  assert.match(link.getAttribute('href'), /[?&]subject=/, 'subject nodes must link to a subject search');
  // Subjects have no creator/recipient split, so exactly one link.
  assert.equal(sr.querySelectorAll('.panel a').length, 1, 'subjects should offer a single link');
});

test('no runtime errors after full interaction', { skip: !ready && why }, () => {
  assert.deepEqual(errors, [], `errors during interaction: ${errors.join(' | ')}`);
});
