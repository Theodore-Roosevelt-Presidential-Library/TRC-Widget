#!/usr/bin/env node
/**
 * TRC Digital Library — taxonomy harvester
 *
 * Pulls every term from the Theodore Roosevelt Center's seven digital-library
 * taxonomies via the public WordPress REST API and writes static JSON to /data
 * for the search widget to consume from GitHub Pages.
 *
 * Why this exists: the TRC's own full-text endpoint (?search= against
 * /wp/v2/digital-library) returns 502 — WP Engine can't scan 139k posts in
 * time. Taxonomy queries work fine. So we cache the vocabulary ourselves and
 * every facet-based search the widget performs costs their server nothing.
 *
 * Usage:
 *   node scripts/harvest.mjs                    # all taxonomies
 *   node scripts/harvest.mjs --only dl_creator  # just one
 *   node scripts/harvest.mjs --fresh            # ignore checkpoints
 *   node scripts/harvest.mjs --dry-run          # probe totals, write nothing
 *
 * No dependencies. Requires Node 18+ (global fetch).
 */

import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchKey, extractDates, decodeEntities } from './names.mjs';
import { fetchGentle, sleep, currentPace, ok } from './http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.harvest-cache');

const API = 'https://www.theodorerooseveltcenter.org/wp-json/wp/v2';

/**
 * `param` / `paramValue` describe how to deep-link this facet back into the
 * TRC's own search form. Both were verified against the live site:
 *
 *   ?creator=lodge-henry-cabot-1850-1924        -> 554 results (matches our count)
 *   ?collection=harvard-college-library         -> 3,368  (matches our count)
 *   ?creator=...&resource_type=Telegram         -> 36     (facets AND correctly)
 *
 * The text facets accept slugs; the two <select>-backed facets (resource type,
 * production method) accept the display name, because that's what their own
 * dropdown submits.
 */
const TAXONOMIES = [
  { slug: 'dl_creator',            file: 'creators',          label: 'Creator',           code: 'cr', param: 'creator',           paramValue: 'slug', personal: true  },
  { slug: 'dl_recipient',          file: 'recipients',         label: 'Recipient',         code: 'rc', param: 'recipient',         paramValue: 'slug', personal: true  },
  { slug: 'dl_subject',            file: 'subjects',           label: 'Subject',           code: 'sb', param: 'subject',           paramValue: 'slug', personal: false },
  { slug: 'dl_collection',         file: 'collections',        label: 'Collection',        code: 'cl', param: 'collection',        paramValue: 'slug', personal: false },
  { slug: 'dl_resource_type',      file: 'resource-types',     label: 'Type',              code: 'rt', param: 'resource_type',     paramValue: 'name', personal: false },
  { slug: 'dl_production_method',  file: 'production-methods', label: 'Production',        code: 'pm', param: 'production_method', paramValue: 'name', personal: false },
  { slug: 'dl_publication',        file: 'publications',       label: 'Publication',       code: 'pb', param: 'publication',       paramValue: 'slug', personal: false },
];

/** How many terms per facet go into the eagerly-loaded head index. */
const HEAD_SIZE = 1000;

// --- tuning -----------------------------------------------------------------
// Deliberately gentle. This is someone else's server and we are a guest on it.
// The patient-retry and adaptive-pacing logic lives in http.mjs, shared with
// the fingerprint harvester. Two facet-harvest specifics:
//
//   - Smaller pages: a per_page=50 query is roughly half the DB work of 100, so
//     it's far likelier to finish under WP Engine's gateway timeout. Twice as
//     many requests, but each one lighter — which is what matters to them.
//   - No orderby (set in the request URL below): the REST default is an indexed
//     name sort. Forcing orderby=id made the database sort the whole taxonomy on
//     every page, the likely cause of the 504s.
const PER_PAGE = 50;

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const ONLY = opt('only');
const FRESH = flag('fresh');
const DRY_RUN = flag('dry-run');

// --- helpers ----------------------------------------------------------------
function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

const fetchWithRetry = (url) => fetchGentle(url, { onRetry: (m) => log(`  ${m}`) });

/**
 * Read the term count from X-WP-Total.
 *
 * Note: we deliberately ignore X-WP-TotalPages. That header reflects the
 * per_page of the *probe* request, not of the harvest requests that follow —
 * probing with per_page=1 reports one page per term. Deriving pages from our
 * own PER_PAGE is the only correct source of truth here, and getting this
 * wrong means walking off the end of the result set into a 400.
 */
async function probeTotals(slug) {
  const url = `${API}/${slug}?per_page=1&_fields=id`;
  const res = await fetchWithRetry(url);
  const total = Number(res.headers.get('x-wp-total') || 0);
  return { total, totalPages: Math.ceil(total / PER_PAGE) };
}

// --- checkpointing ----------------------------------------------------------
// A full harvest of ~100k terms is thousands of requests. If it dies at page
// 700 we do not want to start over, and we especially do not want to hammer
// their server re-fetching what we already have.

async function loadCheckpoint(slug) {
  if (FRESH) return null;
  const f = path.join(CACHE_DIR, `${slug}.json`);
  if (!existsSync(f)) return null;
  try {
    const cp = JSON.parse(await readFile(f, 'utf8'));
    log(`  resuming ${slug} from page ${cp.nextPage} (${cp.terms.length} terms cached)`);
    return cp;
  } catch {
    return null;
  }
}

async function saveCheckpoint(slug, cp) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${slug}.json`), JSON.stringify(cp));
}

async function clearCheckpoint(slug) {
  await rm(path.join(CACHE_DIR, `${slug}.json`), { force: true });
}

// --- harvest ----------------------------------------------------------------
async function harvestTaxonomy(tax) {
  log(`${tax.slug} — probing`);
  const { total, totalPages } = await probeTotals(tax.slug);
  log(`${tax.slug} — ${total.toLocaleString()} terms across ${totalPages} pages`);

  if (DRY_RUN) return { ...tax, total, totalPages, terms: [] };

  const checkpoint = await loadCheckpoint(tax.slug);
  let terms = checkpoint?.terms ?? [];
  let page = checkpoint?.nextPage ?? 1;

  while (page <= totalPages) {
    // No orderby: the REST default is an indexed name sort, which is cheap and
    // stable enough for resuming (terms rarely change mid-harvest). Forcing
    // orderby=id made the DB sort the whole taxonomy on every page — the likely
    // cause of the 504s.
    const url =
      `${API}/${tax.slug}?per_page=${PER_PAGE}&page=${page}&_fields=id,name,slug,count`;

    let batch;
    try {
      const res = await fetchWithRetry(url);
      batch = await res.json();
      ok();   // a stretch of clean requests eases the pace back down
    } catch (err) {
      // A full run takes over an hour. Terms can be added or removed on their
      // end while we're paginating, which shifts the page count under us and
      // sends us past the last page. WP answers that with 400
      // rest_post_invalid_page_number. That's the end of the data, not a
      // failure — keep what we have rather than losing the whole run.
      if (err.message.includes('HTTP 400')) {
        log(`  ${tax.slug} — page ${page} past end of results, stopping (${terms.length.toLocaleString()} terms)`);
        break;
      }
      throw err;
    }

    if (!Array.isArray(batch)) {
      throw new Error(`Unexpected response shape on ${tax.slug} page ${page}`);
    }

    // An empty page before the expected end means the same thing.
    if (batch.length === 0) {
      log(`  ${tax.slug} — empty page ${page}, stopping (${terms.length.toLocaleString()} terms)`);
      break;
    }

    terms.push(...batch);

    // Checkpoint often — pages are half the size now, and a rough patch on
    // their end can end the run at any point. Cheap local writes buy resumability.
    if (page % 10 === 0 || page === totalPages) {
      const pct = Math.round((page / totalPages) * 100);
      log(`  ${tax.slug} ${page}/${totalPages} (${pct}%) — ${terms.length.toLocaleString()} terms, pace ${currentPace()}ms`);
      await saveCheckpoint(tax.slug, { nextPage: page + 1, terms });
    }

    page += 1;
    await sleep(currentPace());
  }

  await clearCheckpoint(tax.slug);
  return { ...tax, total, totalPages, terms };
}

/**
 * Shape terms for the widget.
 *
 * Stored as arrays rather than objects — at ~100k terms the key names alone
 * would cost several megabytes. Field order is documented in data/README.md
 * and mirrored by the widget's loader.
 *
 *   [ id, name, slug, count, searchKey, dates|null ]
 */
function shapeTerms(tax, terms) {
  return terms
    .filter((t) => t && t.name)
    .map((t) => {
      // Decode for display as well as for search — the widget renders `name`
      // directly, and a literal "&amp;" on screen looks broken.
      const name = decodeEntities(t.name);
      const row = [t.id, name, t.slug, t.count ?? 0, buildSearchKey(name)];
      if (tax.personal) {
        const d = extractDates(name);
        row.push(d ? [d.from, d.to] : null);
      }
      return row;
    })
    // Most-used terms first. The widget can then take the top N matches
    // without sorting 100k rows in the browser on every keystroke.
    .sort((a, b) => b[3] - a[3]);
}

/**
 * Re-derive the shaped output from data already on disk, without touching the
 * network.
 *
 * A full harvest takes ~19 minutes and thousands of requests against someone
 * else's server. When only the *derivation* changes — a fix to name parsing or
 * search-key generation — re-fetching identical upstream data would be wasteful
 * and rude. This rebuilds from the raw id/name/slug/count already stored.
 */
async function reshape() {
  log('Reshaping existing data — no network calls');
  const summary = [];

  for (const tax of TAXONOMIES) {
    const file = path.join(DATA_DIR, `${tax.file}.json`);
    if (!existsSync(file)) {
      log(`  skip ${tax.file}.json — not harvested yet`);
      continue;
    }

    const prev = JSON.parse(await readFile(file, 'utf8'));
    // Feed stored rows back through the shaper in the API's object form.
    const asTerms = prev.terms.map(([id, name, slug, count]) => ({ id, name, slug, count }));
    const shaped = shapeTerms(tax, asTerms);

    const payload = { ...prev, fields: tax.personal
        ? ['id', 'name', 'slug', 'count', 'search', 'dates']
        : ['id', 'name', 'slug', 'count', 'search'],
      reshaped: new Date().toISOString(), total: shaped.length, terms: shaped };

    const json = JSON.stringify(payload);
    await writeFile(file, json);

    const changed = shaped.filter((r, i) => r[1] !== prev.terms[i]?.[1] || r[4] !== prev.terms[i]?.[4]).length;
    log(`  ${tax.file}.json — ${shaped.length.toLocaleString()} terms, ${changed.toLocaleString()} rows changed`);
    summary.push({ taxonomy: tax.slug, total: shaped.length, changed });
  }

  console.table(summary);
}

/**
 * Build the merged head index the Quick Search widget loads on init.
 *
 * The widget searches every facet on each keystroke, so shipping seven files
 * and merging in the browser would be wasteful. This pre-merges the most-used
 * terms from each facet into one file, already sorted by count.
 *
 * Pure build step — reads /data, writes /data, no network.
 */
async function buildHead() {
  const rows = [];
  const perFacet = [];

  for (const tax of TAXONOMIES) {
    const file = path.join(DATA_DIR, `${tax.file}.json`);
    if (!existsSync(file)) continue;

    const d = JSON.parse(await readFile(file, 'utf8'));
    const slice = d.terms.slice(0, HEAD_SIZE);

    for (const [id, name, slug, count] of slice) {
      // Deliberately no search key. It's derivable from `name`, and the widget
      // already ships the derivation (names.mjs is inlined into the bundle).
      // Omitting it cuts the head index from 152 KB to 90 KB gzipped — a 40%
      // saving on the one file every visitor downloads — in exchange for ~10ms
      // of startup work.
      rows.push([tax.code, name, tax.paramValue === 'slug' ? slug : name, count, id]);
    }
    perFacet.push({ facet: tax.label, included: slice.length, of: d.terms.length });
  }

  // Global sort by count: the widget can break ties across facets sensibly and
  // stop scanning early on broad queries.
  rows.sort((a, b) => b[3] - a[3]);

  const payload = {
    built: new Date().toISOString(),
    headSize: HEAD_SIZE,
    fields: ['facet', 'name', 'value', 'count', 'id'],
    facets: Object.fromEntries(
      TAXONOMIES.map((t) => [t.code, { label: t.label, param: t.param, file: t.file }]),
    ),
    total: rows.length,
    terms: rows,
  };

  const json = JSON.stringify(payload);
  await writeFile(path.join(DATA_DIR, 'head.json'), json);
  log(`  wrote data/head.json — ${rows.length.toLocaleString()} terms, ${Math.round(json.length / 1024)} KB`);
  console.table(perFacet);
}

async function main() {
  if (flag('head')) return buildHead();
  if (flag('reshape')) { await reshape(); return buildHead(); }

  const selected = ONLY ? TAXONOMIES.filter((t) => t.slug === ONLY) : TAXONOMIES;

  if (!selected.length) {
    console.error(`Unknown taxonomy "${ONLY}". Options: ${TAXONOMIES.map((t) => t.slug).join(', ')}`);
    process.exit(1);
  }

  log(`Harvesting ${selected.length} taxonom${selected.length === 1 ? 'y' : 'ies'}${DRY_RUN ? ' (dry run)' : ''}`);
  await mkdir(DATA_DIR, { recursive: true });

  const summary = [];
  const started = Date.now();

  for (const tax of selected) {
    const result = await harvestTaxonomy(tax);

    if (DRY_RUN) {
      summary.push({ taxonomy: tax.slug, label: tax.label, total: result.total });
      continue;
    }

    const shaped = shapeTerms(tax, result.terms);
    const payload = {
      taxonomy: tax.slug,
      label: tax.label,
      fields: tax.personal
        ? ['id', 'name', 'slug', 'count', 'search', 'dates']
        : ['id', 'name', 'slug', 'count', 'search'],
      harvested: new Date().toISOString(),
      total: shaped.length,
      terms: shaped,
    };

    const outPath = path.join(DATA_DIR, `${tax.file}.json`);
    const json = JSON.stringify(payload);
    await writeFile(outPath, json);

    const kb = Math.round(json.length / 1024);
    log(`  wrote data/${tax.file}.json — ${shaped.length.toLocaleString()} terms, ${kb.toLocaleString()} KB`);

    summary.push({
      taxonomy: tax.slug,
      label: tax.label,
      file: `${tax.file}.json`,
      total: shaped.length,
      bytes: json.length,
      // Sanity signal: if the API silently starts returning empties we want
      // that visible in the committed diff rather than failing silently.
      topTerm: shaped[0] ? { name: shaped[0][1], count: shaped[0][3] } : null,
    });
  }

  if (!DRY_RUN) {
    await writeFile(
      path.join(DATA_DIR, 'meta.json'),
      JSON.stringify(
        {
          source: 'https://www.theodorerooseveltcenter.org/wp-json/wp/v2',
          harvested: new Date().toISOString(),
          durationSeconds: Math.round((Date.now() - started) / 1000),
          taxonomies: summary,
        },
        null,
        2,
      ),
    );
    log('  wrote data/meta.json');
    await buildHead();
  }

  log(`Done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.table(summary);
}

main().catch((err) => {
  console.error('\nHarvest failed:', err.message);
  console.error('Progress is checkpointed in .harvest-cache/ — rerun to resume.');
  process.exit(1);
});
