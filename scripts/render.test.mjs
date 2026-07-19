/**
 * Headless render test for <trc-graph>.
 *
 * Loads the *built bundle* against the *real graph data* in a JSDOM document and
 * drives it like a visitor: initial render, selecting a node, searching, mode
 * switching. Everything else in this project tests data or pure functions; this
 * is the only check that the shipped file works in a DOM.
 *
 * It earned its place immediately — it caught the people graph reporting TR's
 * recipient count (30,656) beside a link returning his creator count (58,180).
 * No data-level test would have seen that: both numbers were right in isolation
 * and only wrong together, on screen.
 *
 * JSDOM has no layout engine and no canvas, so getBoundingClientRect is stubbed
 * and the edge layer is absent. That verifies wiring and data correctness, not
 * visual quality — a real browser remains the final word on whether it looks
 * good.
 *
 * Skips itself if jsdom isn't installed.
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

let win, sr, errors, graphs;

async function mount() {
  graphs = {
    people: JSON.parse(await readFile(path.join(ROOT, 'data/graph-people.json'), 'utf8')),
    subjects: JSON.parse(await readFile(path.join(ROOT, 'data/graph-subjects.json'), 'utf8')),
  };
  const bundle = await readFile(BUNDLE, 'utf8');

  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://trc.labs.trlibrary.com/',
  });
  const { window } = dom;
  errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  // JSDOM logs an unimplemented-canvas notice; that's expected, not a failure.
  window.console.warn = (...a) => {
    const m = a.join(' ');
    if (!/canvas|getContext|not implemented/i.test(m)) errors.push(`warn: ${m}`);
  };
  window.console.error = () => {};

  window.fetch = async (u) => ({
    ok: true, status: 200,
    json: async () => (String(u).includes('subjects') ? graphs.subjects : graphs.people),
  });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.Element.prototype.getBoundingClientRect = () => (
    { width: 900, height: 520, top: 0, left: 0, right: 900, bottom: 520 });

  window.eval(bundle);
  const node = window.document.createElement('trc-graph');
  window.document.body.appendChild(node);
  await new Promise((r) => setTimeout(r, 700));
  return { window, sr: node.shadowRoot };
}

const click = (t) => t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

before(async () => { if (ready) ({ window: win, sr } = await mount()); });

test('the built bundle renders without errors', { skip: !ready && why }, () => {
  assert.deepEqual(errors, [], `errors: ${errors.join(' | ')}`);
  assert.ok(sr.querySelector('svg'), 'no svg');
  assert.ok(sr.querySelector('canvas'), 'no canvas layer');
});

test('the whole network is drawn, not a neighbourhood', { skip: !ready && why }, () => {
  // The regression that prompted this rewrite: the map previously showed ten
  // nodes at a time, so the archive's scale was invisible.
  const drawn = sr.querySelectorAll('g.node').length;
  assert.equal(drawn, graphs.people.nodes.length,
    `expected all ${graphs.people.nodes.length} nodes drawn, got ${drawn}`);
  assert.ok(drawn > 1000, 'the graph should show over a thousand people');
});

test('nodes use precomputed layout coordinates', { skip: !ready && why }, () => {
  const transforms = [...sr.querySelectorAll('g.node')].slice(0, 200)
    .map((n) => n.getAttribute('transform'));
  assert.ok(transforms.every((t) => /translate\([-\d.]+,\s*[-\d.]+\)/.test(t || '')),
    'nodes are not positioned');
  assert.ok(new Set(transforms).size > 100, 'nodes are stacked — layout was not applied');
});

test('node counts agree with the searches they link to', { skip: !ready && why }, () => {
  // TR is both creator (58,180) and recipient (30,656). One combined number
  // beside a single-role link misreports the archive, so each role is its own
  // link with its own count. Both figures verified against the live site.
  const links = [...sr.querySelectorAll('.panel a')];
  assert.equal(links.length, 2, `expected creator and recipient links, got ${links.length}`);

  const wrote = links.find((a) => /Wrote/.test(a.textContent));
  const received = links.find((a) => /Received/.test(a.textContent));
  assert.ok(wrote && received, 'missing a role link');
  assert.match(wrote.getAttribute('href'), /[?&]creator=/);
  assert.match(received.getAttribute('href'), /[?&]recipient=/);
  assert.match(wrote.textContent, /58,180/, `wrote: ${wrote.textContent}`);
  assert.match(received.textContent, /30,656/, `received: ${received.textContent}`);
});

test('the header reports the full scale of the graph', { skip: !ready && why }, () => {
  const txt = sr.querySelector('.count').textContent;
  assert.match(txt, /people/, `count text: "${txt}"`);
  assert.match(txt, new RegExp(graphs.people.nodes.length.toLocaleString()),
    `should state the true node count: "${txt}"`);
});

test('selecting a node focuses it and updates the panel', { skip: !ready && why }, async () => {
  // Deliberately not the root. Roosevelt is connected to 1,503 of the 1,592
  // nodes, so selecting him fades almost nothing — true, but useless as a test
  // of whether focusing works at all.
  const nodes = [...sr.querySelectorAll('g.node')];
  const target = nodes[Math.floor(nodes.length / 2)];
  const idx = nodes.indexOf(target);
  click(target);
  await settle(200);

  assert.equal(sr.querySelectorAll('g.node.sel').length, 1, 'exactly one node should be selected');
  assert.ok(sr.querySelector('.panel h3').textContent.length > 0, 'panel has no heading');

  const neighbours = (graphs.people.edges.filter(([a, b]) => a === idx || b === idx)).length;
  const faded = sr.querySelectorAll('g.node.faded').length;
  assert.equal(faded, graphs.people.nodes.length - (neighbours + 1),
    `fading should hide exactly the non-neighbours (${neighbours} links, ${faded} faded)`);
});

test('Roosevelt dominates the network, and the data says so plainly', { skip: !ready && why }, () => {
  // Not a UI assertion — a guard on the shape of the archive. TR being on the
  // majority of edges is the central fact the map has to cope with; if a future
  // pruning change quietly hid that, the picture would stop being true.
  const g = graphs.people;
  const root = g.root;
  const touching = g.edges.filter(([a, b]) => a === root || b === root).length;
  const share = touching / g.edges.length;
  assert.ok(share > 0.3, `TR should be on a large share of edges, got ${(share * 100).toFixed(0)}%`);
  assert.ok(share < 0.85, `TR on ${(share * 100).toFixed(0)}% of edges leaves no other structure visible`);
});

test('find box locates a person anywhere in the network', { skip: !ready && why }, async () => {
  const input = sr.querySelector('.find input');
  input.value = 'lodge';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(200);

  const hits = [...sr.querySelectorAll('.hits button')];
  assert.ok(hits.length > 0, 'no search results');
  assert.ok(hits.some((b) => /Lodge/i.test(b.textContent)), `no Lodge in: ${hits.map((h) => h.textContent).join(' | ')}`);
  // Word-boundary matching, same discipline as the search widget.
  assert.ok(!hits.some((b) => /Blodgett/i.test(b.textContent)), 'substring match leaked "Blodgett"');
});

test('switching to subjects loads the other graph at full scale', { skip: !ready && why }, async () => {
  click(sr.querySelector('[data-mode=subjects]'));
  await settle(700);

  assert.equal(sr.querySelectorAll('g.node').length, graphs.subjects.nodes.length,
    'subject graph not fully drawn');
  const link = sr.querySelector('.panel a');
  if (link) assert.match(link.getAttribute('href'), /[?&]subject=/);
});

test('labels stay sparse enough to read', { skip: !ready && why }, () => {
  // The bug this guards: the label rule named every neighbour of the focused
  // node. Roosevelt is selected by default and has 1,503 neighbours, so the map
  // rendered 1,504 overlapping labels — a solid mat of text with no visible
  // network underneath. A hub's neighbourhood must be capped.
  const texts = [...sr.querySelectorAll('g.node text')];
  const shown = texts.filter((t) => t.getAttribute('display') !== 'none').length;
  assert.ok(shown > 0, 'no labels at all — the map would be anonymous dots');
  assert.ok(shown <= 40, `${shown} labels at default zoom is an unreadable mat`);
});

test('nodes are large enough to see', { skip: !ready && why }, () => {
  // Radius used to be multiplied by the fit scale, shrinking the median node to
  // ~1.2px: proportional, but invisible. Size encodes item count and belongs in
  // screen units.
  const r = [...sr.querySelectorAll('g.node circle')].map((c) => +c.getAttribute('r'));
  const median = r.sort((a, b) => a - b)[Math.floor(r.length / 2)];
  assert.ok(median >= 2, `median radius ${median.toFixed(2)}px is effectively invisible`);
  assert.ok(Math.max(...r) >= 10, 'the largest hub should be clearly bigger than the rest');
});

test('communities are detected and coloured', { skip: !ready && why }, () => {
  const fills = new Set([...sr.querySelectorAll('g.node circle')].map((c) => c.getAttribute('fill')));
  assert.ok(fills.size >= 5, `only ${fills.size} colours — clustering is not being applied`);
  assert.ok(sr.querySelectorAll('.legend span').length >= 3, 'legend should name the main communities');
});

test('switching tabs rebuilds the map instead of reusing stale nodes', { skip: !ready && why }, async () => {
  // Nodes were keyed by index alone, so People node 0 matched Subjects node 0
  // and d3 reused the DOM — radii and labels stayed stale from the other graph,
  // and the count was wrong by the difference in node counts.
  click(sr.querySelector('[data-mode=people]'));
  await settle(700);
  assert.equal(sr.querySelectorAll('g.node').length, graphs.people.nodes.length,
    'people tab shows the wrong number of nodes');

  click(sr.querySelector('[data-mode=subjects]'));
  await settle(700);
  assert.equal(sr.querySelectorAll('g.node').length, graphs.subjects.nodes.length,
    'subjects tab shows the wrong number of nodes — stale DOM from the other tab');
});

test('full screen control is present', { skip: !ready && why }, () => {
  assert.ok(sr.querySelector('[data-z=full]'), 'no full-screen button');
});

test('no runtime errors after full interaction', { skip: !ready && why }, () => {
  assert.deepEqual(errors, [], `errors: ${errors.join(' | ')}`);
});
