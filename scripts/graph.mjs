#!/usr/bin/env node
/**
 * Derive the two relationship graphs from harvested item fingerprints.
 *
 *   graph-people.json    who corresponded with whom (creator <-> recipient)
 *   graph-subjects.json  which subjects appear together on the same item
 *
 * Pure build step: reads .harvest-cache/fingerprints.jsonl, writes /data.
 * No network. Run `npm run fingerprints` first.
 *
 * ── Two problems this has to solve ────────────────────────────────────────────
 *
 * 1. TR swamps everything. He's the creator on 42% of items and the recipient
 *    on 22%. Drawn naively, the people graph is a single hub with 18,000 spokes
 *    and no visible structure. So the graph is built with TR's direct edges
 *    recorded but *flagged*, letting the widget show the second-order network —
 *    Lodge to Root to Taft — which is the part that actually looks like six
 *    degrees.
 *
 * 2. Size. There are ~600k potential subject-pair edges; shipping them all to a
 *    browser is out of the question. Instead we keep the top N nodes by weight
 *    and, for each, only its strongest K neighbours. That bounds the file
 *    regardless of how the archive grows, and since the widget expands one node
 *    at a time it never needs more than one node's adjacency at once.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import { readFingerprints, FINGERPRINT_FILE, TAX } from './fingerprints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Output directory is overridable so tests can build synthetic graphs into a
// scratch dir instead of overwriting real committed data.
const DATA_IN = path.join(ROOT, 'data');
const DATA = process.env.TRC_GRAPH_OUT || DATA_IN;

// Fingerprint row layout: [id, creators, recipients, subjects, collections, types, methods]
const C = 1 + TAX.indexOf('dl_creator');
const R = 1 + TAX.indexOf('dl_recipient');
const S = 1 + TAX.indexOf('dl_subject');

// Sized for an overview of the whole network rather than a keyhole onto part of
// it. Because the layout is precomputed below, the browser never runs a
// simulation, so these caps are bounded by legibility and file size, not by
// what a phone can simulate at 60fps.
const MAX_NODES = 1600;
const MAX_EDGES = 12;    // strongest neighbours retained per node
const MIN_WEIGHT = 2;    // ignore single co-occurrences: mostly noise, huge tail

// Layout canvas. Coordinates are baked into the data and the widget scales them
// to fit, so these are arbitrary units, not pixels.
const LAYOUT_W = 1600;
const LAYOUT_H = 1100;

const args = process.argv.slice(2);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Undirected pair key with a stable order, so a↔b and b↔a accumulate together. */
const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Load term names/slugs from the taxonomy cache so graph nodes are labelled. */
async function loadTerms(file) {
  const p = path.join(DATA_IN, `${file}.json`);
  if (!existsSync(p)) throw new Error(`Missing data/${file}.json — run \`npm run harvest\` first`);
  const d = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(p, 'utf8')));
  const map = new Map();
  for (const [id, name, slug, count] of d.terms) map.set(id, { name, slug, count });
  return map;
}

/**
 * Reduce a raw edge map to a bounded, widget-sized graph.
 *
 * Node weight is total edge weight, not the archive-wide term count: we want the
 * people who are *connected*, not merely prolific. Someone with 400 items all
 * lacking a correspondent contributes nothing to a correspondence graph.
 */
function prune(edgeWeights, terms, { exclude = new Set(), extra = null } = {}) {
  const nodeWeight = new Map();
  for (const [key, w] of edgeWeights) {
    const [a, b] = key.split('|').map(Number);
    nodeWeight.set(a, (nodeWeight.get(a) || 0) + w);
    nodeWeight.set(b, (nodeWeight.get(b) || 0) + w);
  }

  const keep = [...nodeWeight.entries()]
    .filter(([id]) => terms.has(id) && !exclude.has(id))
    .sort((x, y) => y[1] - x[1])
    .slice(0, MAX_NODES);

  const keepSet = new Set(keep.map(([id]) => id));

  // Bucket surviving edges by node, then keep only each node's strongest few.
  const adj = new Map();
  for (const [key, w] of edgeWeights) {
    if (w < MIN_WEIGHT) continue;
    const [a, b] = key.split('|').map(Number);
    if (!keepSet.has(a) || !keepSet.has(b)) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)).push([b, w]);
    (adj.get(b) ?? adj.set(b, []).get(b)).push([a, w]);
  }

  const edges = new Map();
  for (const [id, list] of adj) {
    list.sort((x, y) => y[1] - x[1]);
    for (const [other, w] of list.slice(0, MAX_EDGES)) edges.set(pair(id, other), w);
  }

  // Drop nodes left with no surviving edges — isolated dots help nobody.
  const connected = new Set();
  for (const key of edges.keys()) {
    const [a, b] = key.split('|').map(Number);
    connected.add(a); connected.add(b);
  }

  const nodes = keep
    .filter(([id]) => connected.has(id))
    .map(([id, w]) => {
      const t = terms.get(id);
      return [id, t.name, t.slug, t.count, w, ...(extra ? extra(t) : [])];
    });

  const index = new Map(nodes.map((n, i) => [n[0], i]));
  const edgeList = [...edges.entries()]
    .map(([key, w]) => {
      const [a, b] = key.split('|').map(Number);
      return [index.get(a), index.get(b), w];
    })
    .filter(([a, b]) => a != null && b != null)
    .sort((x, y) => y[2] - x[2]);

  return { nodes, edges: edgeList };
}

/**
 * Run the force layout here, at build time, and bake x/y into the data.
 *
 * The first version simulated in the browser, which capped what we could show:
 * a live simulation over 1,600 nodes means ~6,000 DOM writes per frame, so the
 * widget only ever displayed a 10-node neighbourhood. That turned the map into a
 * keyhole — you could walk the network but never see it.
 *
 * Precomputing inverts the trade. The browser draws static positions and only
 * pans and zooms, so the whole network renders at once and the visitor sees the
 * shape of the archive immediately. It also makes the layout deterministic:
 * everyone gets the same map, screenshots stay valid, and a bad layout is
 * reproducible instead of a one-off.
 *
 * Cost is ~2 seconds in CI. The browser cost drops to zero.
 */
function layout(nodes, edges, radiusOf, cluster = null) {
  const maxW = Math.max(1, ...edges.map((e) => e[2]));

  /**
   * Cluster anchors.
   *
   * Link forces alone settle into one uniform disc — springs pull connected
   * nodes together but nothing pushes unrelated communities apart, so the
   * picture reads as a blob. Giving each community a home position on a circle
   * and pulling its members gently toward it separates them spatially, which is
   * what makes the structure visible at a glance.
   *
   * The pull is deliberately weak (0.055): strong enough to separate groups,
   * weak enough that the real edges still decide local arrangement. Turn it up
   * and you get tidy meaningless clumps.
   */
  const nClusters = cluster ? Math.max(...cluster) + 1 : 0;
  const anchors = [];
  for (let c = 0; c < nClusters; c++) {
    const a = (c / nClusters) * Math.PI * 2 - Math.PI / 2;
    const spread = Math.min(LAYOUT_W, LAYOUT_H) * 0.33;
    anchors.push([LAYOUT_W / 2 + Math.cos(a) * spread, LAYOUT_H / 2 + Math.sin(a) * spread]);
  }
  const ax = (d) => (cluster ? anchors[cluster[d.i]][0] : LAYOUT_W / 2);
  const ay = (d) => (cluster ? anchors[cluster[d.i]][1] : LAYOUT_H / 2);

  const sim = forceSimulation(nodes.map((n, i) => ({ i, r: radiusOf(n) })))
    .force('link', forceLink(edges.map(([a, b, w]) => ({ source: a, target: b, w })))
      .id((d) => d.i)
      .distance((l) => 26 + 90 * (1 - l.w / maxW))
      .strength((l) => 0.12 + 0.5 * (l.w / maxW)))
    .force('charge', forceManyBody().strength(-150).distanceMax(600))
    .force('collide', forceCollide().radius((d) => d.r + 4).iterations(3))
    .force('x', forceX(ax).strength(cluster ? 0.055 : 0.02))
    .force('y', forceY(ay).strength(cluster ? 0.055 : 0.028))
    .stop();

  // Run to convergence synchronously — no animation frames involved.
  const ticks = Math.ceil(Math.log(0.001) / Math.log(1 - 0.0228));
  for (let i = 0; i < ticks; i++) sim.tick();

  const placed = sim.nodes();
  const xs = placed.map((p) => p.x), ys = placed.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  // Normalise into the layout box so the widget can scale-to-fit without
  // needing to know anything about the simulation's units.
  const sx = LAYOUT_W / Math.max(1, maxX - minX);
  const sy = LAYOUT_H / Math.max(1, maxY - minY);
  const s = Math.min(sx, sy);

  return placed.map((p) => [
    Math.round((p.x - minX) * s),
    Math.round((p.y - minY) * s),
  ]);
}

/** Node radius, area-proportional so one giant hub can't swallow the canvas. */
const radiusFor = (items) => Math.max(2.5, Math.min(34, 2 + Math.sqrt(items) / 9));

/**
 * Community detection by weighted label propagation.
 *
 * Without this the map is an undifferentiated blob: the force layout alone
 * produces one uniform disc, because a spring model has no notion of "these
 * belong together". Communities give the picture its structure — the Army
 * command, the White House staff, the conservation subjects — and give the
 * widget something meaningful to colour by.
 *
 * Label propagation rather than Louvain: it's ~40 lines instead of ~400, needs
 * no dependency, and on a graph this size produces communities that are just as
 * legible. It is not the highest-modularity partition available, but the goal
 * here is a readable picture, not a published clustering.
 *
 * Determinism matters — a map that reshuffles its colours on every build makes
 * screenshots and bug reports worthless — so nodes are visited in a fixed order
 * (degree descending, index as tiebreak) and ties are broken by lowest label.
 */
function communities(nodeCount, edges, { rounds = 24, maxClusters = 9 } = {}) {
  const adj = new Map();
  for (const [a, b, w] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)).push([b, w]);
    (adj.get(b) ?? adj.set(b, []).get(b)).push([a, w]);
  }

  const label = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) label[i] = i;

  const order = [...Array(nodeCount).keys()]
    .sort((x, y) => (adj.get(y)?.length || 0) - (adj.get(x)?.length || 0) || x - y);

  for (let r = 0; r < rounds; r++) {
    let changed = 0;
    for (const i of order) {
      const nbrs = adj.get(i);
      if (!nbrs?.length) continue;
      const score = new Map();
      for (const [j, w] of nbrs) score.set(label[j], (score.get(label[j]) || 0) + w);
      let best = label[i], bestScore = -1;
      for (const [lab, s] of score) {
        if (s > bestScore || (s === bestScore && lab < best)) { best = lab; bestScore = s; }
      }
      if (best !== label[i]) { label[i] = best; changed++; }
    }
    if (!changed) break;
  }

  // Rank communities by size and keep the largest; everything else becomes a
  // single "other" group so the palette stays small enough to read.
  const size = new Map();
  for (const l of label) size.set(l, (size.get(l) || 0) + 1);
  const ranked = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const idx = new Map();
  ranked.slice(0, maxClusters).forEach(([l], i) => idx.set(l, i));

  return label.map((l) => (idx.has(l) ? idx.get(l) : maxClusters));
}

async function main() {
  if (!existsSync(FINGERPRINT_FILE)) {
    console.error('No fingerprints found. Run `npm run fingerprints` first.');
    process.exit(1);
  }

  const [creators, recipients, subjects] = await Promise.all([
    loadTerms('creators'), loadTerms('recipients'), loadTerms('subjects'),
  ]);

  // TR appears as a distinct term ID in each taxonomy.
  const findTR = (m) => [...m.entries()].find(([, t]) => /^Roosevelt, Theodore, 1858-1919$/.test(t.name))?.[0];
  const trCreator = findTR(creators);
  const trRecipient = findTR(recipients);
  const trSubject = findTR(subjects);

  log('Scanning fingerprints…');

  // People: an edge is one item connecting a creator to a recipient.
  // Creator and recipient IDs live in different taxonomies, so the graph is
  // keyed by *person name* rather than term ID — otherwise Lodge-as-writer and
  // Lodge-as-reader would be two unconnected dots.
  const nameToId = new Map();   // canonical name -> representative creator-side id
  const personTerms = new Map();
  const canon = (m, id) => m.get(id)?.name;

  // Item counts are tallied during the scan rather than taken from either
  // taxonomy.
  //
  // A person exists as two term IDs — creator and recipient — with separate
  // counts. Seeding from whichever role appeared first gave TR 30,656 items (his
  // recipient count) while his node linked to a search returning 58,180. Summing
  // the two would double-count items where someone is both. Counting distinct
  // items during the scan is exact, and costs one Set membership test per item.
  const personItems = new Map();
  // Kept separately because the TRC's search can only filter one role at a
  // time: ?creator=x and ?recipient=x are different searches. A node is a
  // person, so the panel offers both and labels each with its own count.
  const personAsCreator = new Map();
  const personAsRecipient = new Map();

  const seedPerson = (name, id, map) => {
    if (!nameToId.has(name)) {
      nameToId.set(name, id);
      const t = map.get(id);
      personTerms.set(id, { name: t.name, slug: t.slug, count: 0 });
    }
    return nameToId.get(name);
  };

  const peopleEdges = new Map();
  const subjectEdges = new Map();
  let items = 0;
  let withPair = 0;
  let dupes = 0;

  // Integrity guard.
  //
  // The first real run silently ingested 975 rows of leftover test fixture that
  // a previous harvest had appended to, inflating edge weights with invented
  // correspondence. Nothing downstream could detect that — a graph made of
  // plausible-looking numbers just looks like a graph. So: reject duplicate item
  // IDs, and refuse to build if the input doesn't match the archive size.
  const seen = new Set();

  for await (const row of readFingerprints()) {
    const itemId = row[0];
    if (seen.has(itemId)) { dupes++; continue; }
    seen.add(itemId);
    items++;

    // ── correspondence ────────────────────────────────────────────────────
    const cs = row[C] || [];
    const rs = row[R] || [];

    // Tally distinct items per person across both roles, before the
    // creator×recipient pairing below (which only runs when both are present).
    const onThisItem = new Set();
    const asC = new Set(), asR = new Set();
    for (const c of cs) { const n = canon(creators, c); if (n) { onThisItem.add(n); asC.add(n); } }
    for (const r of rs) { const n = canon(recipients, r); if (n) { onThisItem.add(n); asR.add(n); } }
    for (const n of onThisItem) personItems.set(n, (personItems.get(n) || 0) + 1);
    for (const n of asC) personAsCreator.set(n, (personAsCreator.get(n) || 0) + 1);
    for (const n of asR) personAsRecipient.set(n, (personAsRecipient.get(n) || 0) + 1);

    if (cs.length && rs.length) {
      withPair++;
      for (const c of cs) {
        const cn = canon(creators, c);
        if (!cn) continue;
        const cid = seedPerson(cn, c, creators);
        for (const r of rs) {
          const rn = canon(recipients, r);
          if (!rn || rn === cn) continue;
          // Prefer an existing creator-side ID for this person if we've seen one.
          const rid = nameToId.get(rn) ?? seedPerson(rn, r, recipients);
          const k = pair(cid, rid);
          peopleEdges.set(k, (peopleEdges.get(k) || 0) + 1);
        }
      }
    }

    // ── subject co-occurrence ─────────────────────────────────────────────
    const ss = (row[S] || []).filter((id) => id !== trSubject);
    // Roosevelt is a subject on 18,491 items; leaving him in would make every
    // subject connect to him and nothing else, which is exactly the hairball
    // we're trying to avoid.
    for (let i = 0; i < ss.length; i++) {
      for (let j = i + 1; j < ss.length; j++) {
        const k = pair(ss[i], ss[j]);
        subjectEdges.set(k, (subjectEdges.get(k) || 0) + 1);
      }
    }

    if (items % 25000 === 0) log(`  ${items.toLocaleString()} items…`);
  }

  log(`Scanned ${items.toLocaleString()} items (${withPair.toLocaleString()} had both a creator and a recipient)`);
  if (dupes) log(`  skipped ${dupes.toLocaleString()} duplicate item IDs`);
  log(`  raw edges — people: ${peopleEdges.size.toLocaleString()}, subjects: ${subjectEdges.size.toLocaleString()}`);

  // Cross-check against the archive size recorded by the taxonomy harvest.
  // Every collection term maps to exactly one item, so their counts sum to the
  // true total. A mismatch means the fingerprint file is stale, truncated, or
  // polluted — all of which produce a graph that looks fine and isn't.
  if (!process.env.TRC_GRAPH_OUT) {
    const collections = await loadTerms('collections');
    const expected = [...collections.values()].reduce((a, t) => a + t.count, 0);
    const drift = Math.abs(items - expected);
    if (drift > expected * 0.02) {
      console.error(
        `\nIntegrity check failed: fingerprints contain ${items.toLocaleString()} items ` +
        `but the archive has ${expected.toLocaleString()}.\n` +
        `A mismatch this large means the fingerprint file is stale or contains foreign rows.\n` +
        `Rebuild it with:  npm run fingerprints -- --fresh\n`,
      );
      process.exit(1);
    }
    log(`  integrity ok — ${items.toLocaleString()} items vs ${expected.toLocaleString()} expected`);
  }

  await mkdir(DATA, { recursive: true });

  // Apply the scanned counts before pruning, so node labels and the searches
  // they link to agree.
  for (const t of personTerms.values()) {
    t.count = personItems.get(t.name) ?? 0;
    t.wrote = personAsCreator.get(t.name) ?? 0;
    t.received = personAsRecipient.get(t.name) ?? 0;
  }

  const people = prune(peopleEdges, personTerms, { extra: (t) => [t.wrote, t.received] });
  const trPersonId = [...personTerms.entries()].find(([, t]) => /^Roosevelt, Theodore, 1858-1919$/.test(t.name))?.[0];
  const trIndex = people.nodes.findIndex((n) => n[0] === trPersonId);

  log('Detecting communities in the people graph…');
  // Communities are computed on the network *without* Roosevelt. He connects to
  // 51% of everyone, so including him collapses the whole graph into a single
  // community and the colouring says nothing.
  const peopleNoTR = people.edges.filter(([a, b]) => a !== trIndex && b !== trIndex);
  const peopleCluster = communities(people.nodes.length, peopleNoTR);
  const peopleGroups = new Set(peopleCluster).size;
  log(`  ${peopleGroups} communities`);

  log('Laying out the people graph…');
  const peoplePos = layout(people.nodes, people.edges, (n) => radiusFor(n[3]), peopleCluster);
  people.nodes.forEach((n, i) => n.push(peoplePos[i][0], peoplePos[i][1]));

  /**
   * A second layout with Roosevelt's direct links removed.
   *
   * He sits on 51% of all edges, so the default map is a starburst: true, but it
   * buries everything else. Drop his edges and the remaining 1,442 rearrange
   * into the actual communities — the Army command around Corbin and MacArthur,
   * the White House staff around Loeb and Cortelyou. That is the "six degrees"
   * structure, and it only becomes visible once the sun is out of the frame.
   *
   * Both layouts ship; the widget toggles between them. Recomputing this in the
   * browser would mean shipping d3-force to every visitor for a view most never
   * open.
   */
  log(`  second layout without Roosevelt (${peopleNoTR.length} of ${people.edges.length} edges remain)…`);
  const altPos = layout(people.nodes, peopleNoTR, (n) => radiusFor(n[3]), peopleCluster);
  people.nodes.forEach((n, i) => n.push(altPos[i][0], altPos[i][1], peopleCluster[i]));

  const peoplePayload = {
    graph: 'people',
    label: 'Correspondence network',
    built: new Date().toISOString(),
    fields: { nodes: ['id', 'name', 'slug', 'items', 'weight', 'wrote', 'received', 'x', 'y', 'x2', 'y2', 'cluster'], edges: ['a', 'b', 'letters'] },
    clusters: peopleGroups,
    altLayout: { label: 'Without Roosevelt', excludes: trIndex },
    param: 'creator',
    roleParams: { wrote: 'creator', received: 'recipient' },
    root: trIndex,
    layout: { w: LAYOUT_W, h: LAYOUT_H },
    scannedItems: items,
    ...people,
  };

  const subs = prune(subjectEdges, subjects, { exclude: new Set([trSubject]) });

  log('Detecting communities in the subject graph…');
  const subCluster = communities(subs.nodes.length, subs.edges);
  const subGroups = new Set(subCluster).size;
  log(`  ${subGroups} communities`);

  log('Laying out the subject graph…');
  const subPos = layout(subs.nodes, subs.edges, (n) => radiusFor(n[3]), subCluster);
  subs.nodes.forEach((n, i) => n.push(subPos[i][0], subPos[i][1], subCluster[i]));

  const subjectsPayload = {
    graph: 'subjects',
    label: 'Subject constellation',
    built: new Date().toISOString(),
    fields: { nodes: ['id', 'name', 'slug', 'items', 'weight', 'x', 'y', 'cluster'], edges: ['a', 'b', 'shared'] },
    clusters: subGroups,
    param: 'subject',
    root: -1,
    layout: { w: LAYOUT_W, h: LAYOUT_H },
    note: 'Roosevelt himself is excluded as a subject — he co-occurs with everything and hides all other structure.',
    scannedItems: items,
    ...subs,
  };

  for (const [file, payload] of [['graph-people', peoplePayload], ['graph-subjects', subjectsPayload]]) {
    const json = JSON.stringify(payload);
    await writeFile(path.join(DATA, `${file}.json`), json);
    log(`  wrote data/${file}.json — ${payload.nodes.length} nodes, ${payload.edges.length} edges, ${Math.round(json.length / 1024)} KB`);
  }

  console.table([
    { graph: 'people', nodes: people.nodes.length, edges: people.edges.length, top: people.nodes[0]?.[1] },
    { graph: 'subjects', nodes: subs.nodes.length, edges: subs.edges.length, top: subs.nodes[0]?.[1] },
  ]);
}

main().catch((e) => { console.error('Graph build failed:', e.message); process.exit(1); });
