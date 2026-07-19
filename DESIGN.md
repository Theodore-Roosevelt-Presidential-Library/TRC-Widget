# Widget design notes

Design decisions and — more importantly — what building the UI revealed about the
data model. This document exists because the prototype answered questions the
spreadsheet couldn't.

## Settled

- **Results deep-link to theodorerooseveltcenter.org, `target="_blank"`.** We are
  a better front door, not a replacement. Citations stay canonical, traffic goes
  to them.
- **Preview before the click.** Users should see what they're about to get.
- **One smart box, not seven fields.** The current form asks the user to know
  which of seven fields their query belongs in. They don't. Search everything,
  label each suggestion with its facet, let them pick.

## The core interaction

Type → suggestions from all facets at once, each labeled and counted → select →
it becomes a chip → filters AND together → preview updates → open at TRC.

Three things make this work that the current site can't do:

1. **Counts on every suggestion.** "Letter · 108,670" vs "Diary · 92" tells you
   instantly where the material is. This is the single highest-value thing the
   cached data gives us.
2. **Word-boundary matching against the search key.** Typing `lodge` must surface
   Henry Cabot Lodge, not Blodgett. Typing `henry cabot lodge` must work at all.
3. **Facet labels on suggestions.** "Roosevelt, Theodore" exists as a Creator
   (58,180), a Recipient (30,656) *and* a Subject (18,491) — three genuinely
   different questions. The UI has to disambiguate rather than hide it.

---

## What the prototype changed about the data model

### 1. We need a merged head index, not just per-facet files

The unified box searches all facets on every keystroke. Loading seven files and
merging client-side is wasteful. **Add a build step producing `head.json`:** the
top ~1,000 terms from each facet, pre-merged, each row carrying its facet, sorted
by count.

Estimated ~250 KB raw / ~70 KB gzipped for ~5,000 rows. Loaded once, covers the
overwhelming majority of queries with zero further requests.

Per-facet files stay for the Guided widget and for tail lookups.

### 2. Result counts for combined filters cannot be precomputed

The prototype fakes the "~N matching items" number, and there's no honest way to
compute it from cached data. Term counts are per-term; the intersection of
`creator=Lodge AND type=Letter` is unknowable without asking.

Three options, in order of preference:

- **Ask their API for the count.** A `HEAD`/1-item request to
  `/wp/v2/digital-library?dl_creator=X&dl_resource_type=Y&per_page=1` returns
  `X-WP-Total` in the headers. One cheap request per filter change, debounced.
  Verified working.
- **Show a range or omit the number** until the user commits.
- Precompute common pairs. Rejected — combinatorial, stale, not worth it.

**Recommendation: option 1.** It's one small request on a deliberate user action,
it's accurate, and it degrades gracefully — if it fails we just don't show a
number. It also powers the preview, so it's one request, not two.

### 3. Preview items come live from their API, and it works

`/wp/v2/digital-library?dl_creator=292110&per_page=3` returns items with title,
link, date, and rich metadata. **Verified.** This is the preview.

Important: we need **term IDs** for this, not names. The cached files already
store `id` — good. But see the next item.

### 4. Deep-link parameters need verification

Their search form is `GET /digital-library/?creator=...&resource_type=...`, and
it appears to take **display names**, while the REST API takes **term IDs** and
taxonomy archives use **slugs**. Our cache has all three, so we're covered either
way — but which the form actually wants is **untested and needs a controlled
check** before we ship a single link.

Related open question from FINDINGS: whether `keyword` + facet actually AND
together on their end. Same test.

### 5. Thumbnails are not in the REST API

Item records carry no image URL. Thumbnails appear in their search-results HTML,
served from S3 (`theodorerooseveltcenter.s3.us-west-2.amazonaws.com`), on paths
derived from collection + internal identifiers — not reconstructible from the
item ID.

Options: harvest thumbnail URLs as a second pass over items (expensive — 139k
items), scrape them from result HTML (fragile, and their HTML 502s), or **ship
preview as metadata-only with a placeholder**, which is what the prototype does.

**Recommendation: metadata-only for v1.** Title, date, collection, and type
already tell the user what they're about to open. Images are a v2 enhancement,
and worth raising with the TRC team — if they can expose `featured_media` or an
ACF image field, it becomes trivial.

### 6. Their site is genuinely unreliable

We hit 502s on the item REST endpoint, the item HTML page, and full-text search —
repeatedly, across a session. This is not incidental to the project:

- Every live call must fail soft. Preview unavailable is fine; a broken widget is not.
- The cached autocomplete keeps working when their site is down. **Our widget
  stays useful when theodorerooseveltcenter.org isn't** — a strong argument for
  the cache-first architecture beyond mere speed.
- Worth raising with them. Their 502s are costing them real traffic.

---

## Widget roadmap

| Widget | Data needed | Status |
|---|---|---|
| Quick Search | `head.json` + live count/preview | prototype |
| Guided / Advanced | per-facet files + prefix shards | not started |
| Featured / Browse | small curated JSON, hand-authored | not started |
| Embed-a-Search | none — reads URL params | not started |

## Next build steps

1. Add `head.json` generation to the harvester (build step, no new fetching).
2. Controlled test of their query params — names vs slugs vs IDs, and whether
   keyword ANDs with facets.
3. Wire live count + preview with debounce and fail-soft.
4. Package as a Web Component with Shadow DOM.
