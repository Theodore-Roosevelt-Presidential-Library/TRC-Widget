# TRC-Widget

Embeddable search widgets for the [Theodore Roosevelt Center digital
library](https://www.theodorerooseveltcenter.org/digital-library/) — 139,714
archival items across 52 partner institutions. Built to drop onto
trlibrary.com, or any other site, with a single script tag.

See [FINDINGS.md](./FINDINGS.md) for the research behind the approach.

## Why this exists

The TRC's advanced search exposes seven facets but offers no autocomplete on any
of them. The underlying data is a controlled Library of Congress vocabulary
(`Lodge, Henry Cabot, 1850-1924`), so a visitor typing "henry cabot lodge" gets
zero results while "lodge" surfaces "Blodgett". The vocabulary is excellent; the
door into it is the problem.

## How it works

The TRC runs WordPress with a fully open REST API, and all seven facets are real
taxonomies. **This project caches that vocabulary as static JSON** and serves it
from GitHub Pages, so:

- Autocomplete is instant — no round trip to their server.
- Every suggestion shows a live result count.
- Facet searches cost the TRC's WP Engine instance nothing.
- Their full-text endpoint, which currently returns 502 under load, is never in
  the critical path.

```
GitHub Action (weekly)  →  /data/*.json  →  GitHub Pages  →  widget
```

## Install

```html
<script src="https://trc.labs.trlibrary.com/trc-search.min.js" defer></script>

<trc-search></trc-search>
```

6.5 KB gzipped. No dependencies, no framework, no build step on your end. Renders
in a shadow root, so it can't collide with the host page's CSS.

| Attribute | Description |
|---|---|
| `placeholder` | Input placeholder text |
| `collection` | Lock searches to one collection slug |
| `accent` | Shorthand for `--trc-rust`. Any CSS color |
| `theme` | `inherit` uses the host page's fonts; `auto` enables dark mode |
| `preview` | `off` disables live count and preview requests |
| `data-base` | Override where the index is loaded from |

## Theming

Styled to match the Theodore Roosevelt Center: navy `#132E52`, rust `#BC4C01`,
sage `#BED0CE`, paper `#F7F6F2`, Aleo headings, Nunito Sans body, 5px radius.

Every value is a CSS custom property, so the host page can retheme any single
token without forking:

```css
trc-search {
  --trc-rust: #8c1515;
  --trc-navy: #1a1a1a;
  --trc-sage: #e8e2d5;
  --trc-paper: #fafafa;
  --trc-radius: 0;
  --trc-body: inherit;
}
```

The widget **never fetches webfonts** — that would add a network dependency and
a third-party privacy footprint to something meant to drop into any page. Aleo
and Nunito Sans are declared as a stack, so they're used when the host already
serves them (as trlibrary.com and the TRC do) and fall back to a system stack
otherwise. `theme="inherit"` adopts the host's typography instead.

Dark mode is opt-in via `theme="auto"`. Both the TRC and trlibrary.com are
light-only, so auto-inverting on a light host page would look broken rather than
considerate.

Emits `trc-filter` on the element whenever active filters change.

## Relationship map

A second, independent widget — an interactive map of how people and subjects
connect across the archive. Opens on Roosevelt and expands as you click.

```html
<script src="https://trc.labs.trlibrary.com/trc-graph.min.js" defer></script>

<trc-graph></trc-graph>                  <!-- correspondence network -->
<trc-graph mode="subjects"></trc-graph>  <!-- subject constellation -->
```

5.5 KB gzipped, no dependencies — the force simulation is ~40 lines rather than
a 90 KB D3 import. Shares the same theme tokens as `<trc-search>`. Emits
`trc-node` when a node is selected.

**Two things the data forced:**

*The graph shows one neighbourhood at a time, not the whole network.* TR is on
42% of items, so drawing everything produces a starburst that communicates
nothing. Walking outward from a node is both more legible and more honest about
how the archive is shaped.

*Roosevelt is excluded from the subject constellation.* He's tagged on 18,491
items, so leaving him in connects every subject to him and to nothing else. The
people graph keeps him, because there he is the point.

### Building the graph data

The graphs need a full item scan — every item's taxonomy term IDs:

```bash
npm run fingerprints   # ~1,400 requests, ~15 min, resumable
npm run graphs         # derive both graphs, no network
```

Fingerprints land in `.harvest-cache/` and are **not committed** — at ~8 MB
refreshed weekly they'd add hundreds of megabytes to repo history within a year.
The derived graph files are small and are what ships. In CI the cache persists
between runs, so re-deriving normally costs nothing.

> The same fingerprint data can precompute exact co-occurrence for every filter
> combination, which would let `<trc-search>` drop its live scanning of the TRC
> API entirely. Not wired up yet — see DESIGN.md.

## Deployment

Hosted at **https://trc.labs.trlibrary.com** (GitHub Pages, custom domain).

The `CNAME` file is committed and copied into every deploy. Don't delete it — an
Actions-based deploy without it can reset the custom domain in repo settings, and
the site silently reverts to `*.github.io`, breaking every embed already in the wild.

DNS: `trc.labs` → `CNAME` → `mbriney.github.io`. In repo settings, Pages source
must be **GitHub Actions**, with "Enforce HTTPS" enabled once the certificate
provisions (usually a few minutes after DNS resolves).

### Cross-origin notes

The widget is designed to be embedded on other domains, so both its fetches are
cross-origin:

1. **Its own index** (`trc.labs.trlibrary.com/data/head.json`) — GitHub Pages sends
   `Access-Control-Allow-Origin: *`, so this works from any host page. The script
   resolves its own absolute base URL from `document.currentScript.src`.
2. **The TRC API** (`theodorerooseveltcenter.org/wp-json/...`) for live counts,
   previews and co-occurrence. WordPress sends permissive CORS headers by default,
   but a WAF or security plugin can strip them.

If the TRC API blocks the browser's origin, fetch rejects with a bare `TypeError`
that's indistinguishable from the site being down. The widget logs one clear
console warning naming CORS as the likely cause, then carries on — autocomplete
and deep links are unaffected, only live counts and previews go away.

## Status

- [x] Harvester — all seven taxonomies, resumable, tested
- [x] Weekly GitHub Action with sanity checks
- [x] Merged head index (4,179 terms, 90 KB gzipped)
- [x] Quick Search widget + Pages deploy
- [ ] Prefix shards for the long tail
- [ ] Guided / Advanced widget
- [ ] Featured / Browse widget
- [ ] Embed-a-Search

## Development

```bash
npm test          # name tests + smoke test against the real index
npm run build     # bundle to dist/
npm run serve     # dev server at localhost:8080 (fetch needs http://)
```

Refreshing the data:

```bash
npm run harvest:dry   # probe term counts, write nothing
npm run harvest       # full harvest (~19 min, resumable)
npm run reshape       # re-derive from cached data, no network
npm run head          # rebuild the merged head index
```

Node 18+. No dependencies anywhere in the project.

## Layout

```
src/widget.js            the <trc-search> element
scripts/names.mjs        name normalization — single source of truth,
                           inlined into the bundle at build time
scripts/names.test.mjs   unit tests, fixtures from real API responses
scripts/harvest.mjs      harvester + head-index builder
scripts/build.mjs        bundler
scripts/smoke.mjs        end-to-end search behaviour against the real index
scripts/serve.mjs        local dev server
data/                    generated cache — see data/README.md
index.html               demo + documentation page
.github/workflows/       weekly harvest, Pages deploy
```

## Testing

`npm test` runs two layers. `names.test.mjs` covers name parsing in isolation.
`smoke.mjs` runs the widget's actual ranking algorithm against the actual head
index and asserts on real results — that "henry cabot lodge" finds the man, that
"lodge" doesn't surface "Blodgett", that "theodore roosevelt" ranks the person
above the national park. Both gate the Pages deploy.

## A note on being a good guest

The harvester runs weekly, pauses 250ms between requests, backs off
exponentially on errors, identifies itself in the User-Agent, and checkpoints so
a failed run never re-fetches what it already has. We are reading someone else's
public API on a schedule; the point is that they never notice.
