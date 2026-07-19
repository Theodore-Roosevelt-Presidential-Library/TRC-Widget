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

const MAX_NODES = 700;   // nodes kept per graph
const MAX_EDGES = 14;    // strongest neighbours retained per node
const MIN_WEIGHT = 2;    // ignore single co-occurrences: mostly noise, huge tail

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

  const peoplePayload = {
    graph: 'people',
    label: 'Correspondence network',
    built: new Date().toISOString(),
    fields: { nodes: ['id', 'name', 'slug', 'items', 'weight', 'wrote', 'received'], edges: ['a', 'b', 'letters'] },
    param: 'creator',
    roleParams: { wrote: 'creator', received: 'recipient' },
    root: trIndex,
    scannedItems: items,
    ...people,
  };

  const subs = prune(subjectEdges, subjects, { exclude: new Set([trSubject]) });
  const subjectsPayload = {
    graph: 'subjects',
    label: 'Subject constellation',
    built: new Date().toISOString(),
    fields: { nodes: ['id', 'name', 'slug', 'items', 'weight'], edges: ['a', 'b', 'shared'] },
    param: 'subject',
    root: -1,
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
