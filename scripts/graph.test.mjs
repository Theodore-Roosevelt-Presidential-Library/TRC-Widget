/**
 * End-to-end test of the graph build, run against synthetic fingerprints.
 *
 * The real harvest is ~1,400 requests against someone else's server; re-running
 * it to check a pruning tweak would be both slow and rude. Instead this
 * generates a fingerprint file with known structure, runs the real graph
 * builder over it as a subprocess, and asserts on the output.
 *
 * The synthetic archive deliberately mirrors the real one's pathologies:
 * a dominant TR hub, a long tail of one-off correspondents, and a few tight
 * subject clusters that should survive pruning.
 *
 * Run: node --test scripts/graph.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.harvest-cache');
// A dedicated path, never the real one. An earlier version wrote synthetic
// rows to .harvest-cache/fingerprints.jsonl; the next real harvest appended to
// them and corrupted both graphs with 975 fake items.
const FP = path.join(CACHE, 'fingerprints.test.jsonl');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(CACHE, 'graph-test-out');

// Term IDs from the real taxonomy cache, so labels resolve.
let TR_C, TR_R, TR_S, LODGE_C, LODGE_R, ROOT_C, ROOT_R, SUBJ;

before(async () => {
  const load = async (f) => JSON.parse(await readFile(path.join(DATA, `${f}.json`), 'utf8'));
  const creators = await load('creators');
  const recipients = await load('recipients');
  const subjects = await load('subjects');

  const find = (d, re) => d.terms.find((t) => re.test(t[1]))?.[0];
  TR_C = find(creators, /^Roosevelt, Theodore, 1858-1919$/);
  TR_R = find(recipients, /^Roosevelt, Theodore, 1858-1919$/);
  TR_S = find(subjects, /^Roosevelt, Theodore, 1858-1919$/);
  LODGE_C = find(creators, /^Lodge, Henry Cabot, 1850-1924$/);
  LODGE_R = find(recipients, /^Lodge, Henry Cabot, 1850-1924$/);
  ROOT_C = find(creators, /^Root, Elihu, 1845-1937$/);
  ROOT_R = find(recipients, /^Root, Elihu, 1845-1937$/);

  // A handful of real subject IDs to build clusters from.
  SUBJ = subjects.terms.slice(1, 40).map((t) => t[0]);

  assert.ok(TR_C && TR_R && LODGE_C && LODGE_R, 'expected people should exist in the taxonomy cache');

  await mkdir(CACHE, { recursive: true });

  const rows = [];
  const fp = (id, c, r, s) => rows.push(JSON.stringify([id, c, r, s, [], [], []]));
  let id = 1;

  // TR hub: 300 items each way. Should dominate node weight, as in reality.
  for (let i = 0; i < 300; i++) fp(id++, [TR_C], [LODGE_R], [TR_S, SUBJ[0]]);
  for (let i = 0; i < 300; i++) fp(id++, [LODGE_C], [TR_R], [TR_S, SUBJ[1]]);

  // Second-order structure: the part that should be visible once TR is set aside.
  for (let i = 0; i < 40; i++) fp(id++, [LODGE_C], [ROOT_R], [SUBJ[2], SUBJ[3]]);
  for (let i = 0; i < 25; i++) fp(id++, [ROOT_C], [LODGE_R], [SUBJ[2], SUBJ[4]]);

  // Tight subject cluster: 5 subjects always co-occurring.
  for (let i = 0; i < 60; i++) fp(id++, [TR_C], [LODGE_R], SUBJ.slice(5, 10));

  // Long tail: single co-occurrences that MIN_WEIGHT should discard.
  for (let i = 0; i < 200; i++) fp(id++, [TR_C], [LODGE_R], [SUBJ[20 + (i % 15)], SUBJ[30 + (i % 9)]]);

  // Items with no recipient — must not create correspondence edges.
  for (let i = 0; i < 50; i++) fp(id++, [TR_C], [], [SUBJ[0]]);

  await writeFile(FP, rows.join('\n') + '\n');
  await mkdir(OUT, { recursive: true });
  await run('node', [path.join(ROOT, 'scripts/graph.mjs')], { cwd: ROOT, env: { ...process.env, TRC_GRAPH_OUT: OUT, TRC_FINGERPRINTS: FP } });
});

after(async () => {
  // Best-effort only; the test file is isolated so a leftover is harmless.
  try { await writeFile(FP, ''); } catch { /* ignore */ }
});

const readGraph = async (n) => JSON.parse(await readFile(path.join(OUT, `graph-${n}.json`), 'utf8'));

test('people graph builds with labelled nodes and weighted edges', async () => {
  const g = await readGraph('people');
  assert.ok(g.nodes.length > 0, 'no nodes produced');
  assert.ok(g.edges.length > 0, 'no edges produced');
  const names = g.nodes.map((n) => n[1]);
  assert.ok(names.some((n) => /Lodge, Henry Cabot/.test(n)), `Lodge missing: ${names.join(', ')}`);
  assert.ok(names.some((n) => /Roosevelt, Theodore/.test(n)), 'TR missing');
});

test('a person is one node, not separate writer and reader nodes', async () => {
  const g = await readGraph('people');
  const lodges = g.nodes.filter((n) => /^Lodge, Henry Cabot/.test(n[1]));
  assert.equal(lodges.length, 1,
    `Lodge should appear once, got ${lodges.length} — creator and recipient IDs were not unified`);
});

test('TR is identified as the root node so the widget can open on him', async () => {
  const g = await readGraph('people');
  assert.ok(g.root >= 0, 'root index not set');
  assert.match(g.nodes[g.root][1], /^Roosevelt, Theodore/, `root is ${g.nodes[g.root][1]}`);
});

test('second-order structure survives — Lodge and Root are connected', async () => {
  const g = await readGraph('people');
  const idx = (re) => g.nodes.findIndex((n) => re.test(n[1]));
  const l = idx(/^Lodge, Henry Cabot/);
  const r = idx(/^Root, Elihu/);
  assert.ok(l > -1 && r > -1, 'Lodge or Root missing from graph');
  const edge = g.edges.find(([a, b]) => (a === l && b === r) || (a === r && b === l));
  assert.ok(edge, 'the Lodge–Root edge was pruned away — second-order network lost');
  assert.equal(edge[2], 65, `expected 40+25=65 letters between them, got ${edge[2]}`);
});

test('items lacking a recipient produce no correspondence edge', async () => {
  const g = await readGraph('people');
  const idx = (re) => g.nodes.findIndex((n) => re.test(n[1]));
  const tr = idx(/^Roosevelt, Theodore/);
  const lodge = idx(/^Lodge, Henry Cabot/);
  const edge = g.edges.find(([a, b]) => (a === tr && b === lodge) || (a === lodge && b === tr));
  assert.ok(edge, 'TR–Lodge edge missing');

  // Every synthetic row pairing these two: 300 TR->Lodge, 300 Lodge->TR,
  // 60 subject-cluster rows and 200 long-tail rows, all TR_C -> LODGE_R.
  // The 50 rows with a creator but no recipient must contribute nothing —
  // if they leaked in we'd see 910.
  assert.equal(edge[2], 860,
    `expected exactly 860; ${edge[2]} means recipient-less items were counted`);
});

test('subject graph excludes Roosevelt himself', async () => {
  const g = await readGraph('subjects');
  assert.ok(!g.nodes.some((n) => /^Roosevelt, Theodore, 1858-1919$/.test(n[1])),
    'TR present as a subject — he co-occurs with everything and hides all structure');
});

test('tight subject clusters survive pruning', async () => {
  const g = await readGraph('subjects');
  assert.ok(g.nodes.length > 0, 'no subject nodes');
  assert.ok(g.edges.length > 0, 'no subject edges');
  const heaviest = g.edges[0][2];
  assert.ok(heaviest >= 60, `strongest subject edge is ${heaviest}, expected the 60-item cluster`);
});

test('single co-occurrences are discarded as noise', async () => {
  const g = await readGraph('subjects');
  assert.ok(g.edges.every((e) => e[2] >= 2),
    `found an edge with weight < 2: ${JSON.stringify(g.edges.find((e) => e[2] < 2))}`);
});

test('graphs stay within the size budget for embedding', async () => {
  for (const name of ['people', 'subjects']) {
    const g = await readGraph(name);
    assert.ok(g.nodes.length <= 700, `${name}: ${g.nodes.length} nodes exceeds cap`);
    // Every node's degree is capped, so total edges can't run away.
    assert.ok(g.edges.length <= 700 * 14, `${name}: ${g.edges.length} edges exceeds cap`);
    assert.ok(g.edges.every(([a, b]) => a < g.nodes.length && b < g.nodes.length),
      `${name}: edge references a node index out of range`);
  }
});

test('no self-edges', async () => {
  for (const name of ['people', 'subjects']) {
    const g = await readGraph(name);
    assert.ok(g.edges.every(([a, b]) => a !== b), `${name}: self-edge present`);
  }
});
