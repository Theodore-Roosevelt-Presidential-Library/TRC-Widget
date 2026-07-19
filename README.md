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
<script src="https://mbriney.github.io/TRC-Widget/trc-search.min.js" defer></script>

<trc-search></trc-search>
```

6.5 KB gzipped. No dependencies, no framework, no build step on your end. Renders
in a shadow root, so it can't collide with the host page's CSS.

| Attribute | Description |
|---|---|
| `placeholder` | Input placeholder text |
| `collection` | Lock searches to one collection slug |
| `accent` | Any CSS color (default `#7b3f00`) |
| `preview` | `off` disables live count and preview requests |
| `data-base` | Override where the index is loaded from |

Emits `trc-filter` on the element whenever active filters change.

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
