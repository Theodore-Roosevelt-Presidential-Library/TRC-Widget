# TRC Digital Library Widget — Exploratory Findings

Date: 2026-07-18
Target: embeddable archive search widget for trlibrary.com (and any other site)
Source: https://www.theodorerooseveltcenter.org/digital-library/

---

## Headline

**We don't need to scrape the site.** The Theodore Roosevelt Center runs on WordPress
(WP Engine, theme built by Big Sea) and its **public REST API is wide open**. Every
facet in the advanced search is a real WordPress taxonomy with a queryable REST
endpoint. That means autocomplete is not a hack — it's a first-class query.

This turns the project from "scrape and reverse-engineer" into "consume a documented
API and build a better front end."

---

## What's actually there

### Corpus size
- **139,714 items** total in the digital library.
- Post type: `digital-library`
- Item permalinks: `https://www.theodorerooseveltcenter.org/digital-library/o312007/`

### The six facets are all taxonomies

| Facet | Taxonomy slug | REST endpoint |
|---|---|---|
| Subject | `dl_subject` | `/wp-json/wp/v2/dl_subject` |
| Collection | `dl_collection` | `/wp-json/wp/v2/dl_collection` |
| Creator | `dl_creator` | `/wp-json/wp/v2/dl_creator` |
| Recipient | `dl_recipient` | `/wp-json/wp/v2/dl_recipient` |
| Resource Type | `dl_resource_type` | `/wp-json/wp/v2/dl_resource_type` |
| Production Method | `dl_production_method` | `/wp-json/wp/v2/dl_production_method` |
| Publication | `dl_publication` | `/wp-json/wp/v2/dl_publication` |

Each term returns `id`, `name`, `slug`, `count`, `link`. **`count` is the killer
feature** — we can show result counts inline in the autocomplete dropdown before the
user ever commits to a search.

Verified working:
```
/wp-json/wp/v2/dl_creator?search=lodge&per_page=10&_fields=id,name,slug,count
```
Returns e.g. `Lodge, Anna Cabot Mills Davis, 1851-1915` (13 items),
`Lodge, George Cabot, 1873-1909` (10 items).

### Item records are rich
A single item returns: `id`, `date`, `link`, `title`, `content`, `featured_media`,
`acf`, `yoast_head`, plus arrays of term IDs for all seven taxonomies. Thumbnails are
on S3 (`theodorerooseveltcenter.s3.us-west-2.amazonaws.com`) and hot-linkable.

### Existing search form (for reference / fallback)
`GET https://www.theodorerooseveltcenter.org/digital-library/` with params:
`keyword`, `creator`, `recipient`, `subject`, `resource_type`,
`production_method`, `date_range_from`, `date_range_to`

Pagination is path-based: `/digital-library/page/2/?keyword=...`

---

## The problems worth solving

These are the reasons the current advanced search feels overwhelming, and each one is
a concrete design opportunity.

**1. No autocomplete anywhere it matters.**
Creator, Recipient, Subject, and Publication are free-text boxes. But the underlying
data is a controlled vocabulary in Library-of-Congress name-authority format —
`Lodge, Henry Cabot, 1850-1924`. A user typing "henry cabot lodge" will match nothing.
This is the single biggest usability failure and the easiest to fix.

**2. Two dropdowns with ~130 and ~5 options respectively.**
Resource Type has roughly 130 entries in one flat alphabetical `<select>`, ranging
from `Letter` (108,670 items) to `Spoon, Demitasse`. There is no signal about which
options are useful. A type-ahead with counts, plus a short "most common" list, fixes
this immediately.

**3. Full-text search on the API times out.**
`?search=` against `/wp-json/wp/v2/digital-library` returns **502 Bad Gateway** —
WP Engine can't do a full-text scan across 139k posts in time. Taxonomy-filtered
queries work fine.

> This is the finding that justifies the GitHub Actions cache. We cannot rely on the
> live API for keyword search. We either build our own index, or we hand keyword
> searches off to the site's own HTML search page.

**4. Keyword + facet may not actually AND together.**
`?keyword=panama+canal&resource_type=Letter` returned 108,670 results — identical to
what `resource_type=Letter` alone appears to return. Either the keyword was silently
ignored or it ORs. **This needs confirmation before we design around it**, and if it's
a real bug on their end it's worth reporting to the TRC team.

**5. 139,714 results is the default state.**
Landing on an undifferentiated result set of everything is not a starting point, it's
a wall. Good archive UX starts with either a question or a curated door in.

---

## Architecture — what I'd propose

### The cache (GitHub Actions)
Nightly or weekly job that pulls all terms from all seven taxonomies via REST
pagination and commits static JSON to the repo:

```
/data/creators.json          ~ name, slug, count
/data/recipients.json
/data/subjects.json
/data/collections.json
/data/resource-types.json
/data/production-methods.json
/data/publications.json
/data/meta.json              ~ totals, last-built timestamp
```

**Measured 2026-07-18** via `npm run harvest:dry` — the earlier ~100k estimate
from term-ID range was close:

| Taxonomy | Terms | Pages @100 |
|---|---:|---:|
| `dl_subject` | 40,196 | 402 |
| `dl_recipient` | 35,230 | 353 |
| `dl_creator` | 18,783 | 188 |
| `dl_publication` | 2,158 | 22 |
| `dl_resource_type` | 121 | 2 |
| `dl_collection` | 53 | 1 |
| `dl_production_method` | 5 | 1 |
| **Total** | **96,546** | **969** |

A full harvest is ~969 requests, roughly 10 minutes at our deliberate pacing.
Comfortably inside the Action's timeout.

Note the shape here: **three big facets and four tiny ones.** Collections,
resource types and production methods are ~180 terms combined — those ship as a
single trivial file the widget can load eagerly on page load.

### First full harvest — 2026-07-18, 19 minutes

| File | Terms | Raw | Gzipped |
|---|---:|---:|---:|
| `subjects.json` | 40,196 | 4.9 MB | 1.4 MB |
| `recipients.json` | 35,230 | 4.4 MB | 1.3 MB |
| `creators.json` | 18,783 | 2.9 MB | 859 KB |
| `publications.json` | 2,158 | 241 KB | 52 KB |
| `resource-types.json` | 121 | 6 KB | 2 KB |
| `collections.json` | 53 | 6 KB | 2 KB |
| `production-methods.json` | 5 | <1 KB | <1 KB |

### The distribution is what decides the widget design

The archive is **extremely long-tailed**:

| Facet | Terms used once | 80% of taggings covered by |
|---|---:|---|
| Creators | 71.7% | top 676 terms (3.6%) |
| Recipients | 78.7% | top 11,395 terms (32.3%) |
| Subjects | 47.8% | top 3,557 terms (8.8%) |

Nearly three-quarters of creators appear on exactly one item. That tail is not
noise to be discarded — **it is the archive's actual research value.** Finding
the single 1903 letter to your great-grandfather is the thing a good archive
search must do, and it's precisely what the current UI makes impossible.

So: don't choose between head and tail, serve both.

**Two-tier loading.**
1. **Head file** — top ~1,000 terms per facet, ~40 KB gzipped, loaded eagerly.
   Covers the overwhelming majority of realistic queries with zero latency, and
   gives us instant default suggestions before the user types anything.
2. **Prefix shards** — the tail, split by first letter, fetched on demand once
   the user has typed one character. Measured largest shards:
   subjects `c` = 3,987 terms (~489 KB raw / ~130 KB gz), recipients `b` = 3,643,
   creators `b` = 1,772. Comfortably sized, and only one is ever fetched.

Nobody downloads 1.4 MB. Common queries feel instant; rare ones cost a single
~130 KB request.

### Data quality note — fixed

The first harvest surfaced **388 terms with HTML-encoded names** (`Underwood
&amp; Underwood`), all `&amp;`. This broke twice: a literal `&amp;` rendered on
screen, and normalization turned the entity into the word "amp", so the search
key read `underwood amp underwood` and a user typing "underwood & underwood"
matched nothing. Fixed in `names.mjs` with entity decoding, covered by tests.

Because only the *derivation* changed and not the upstream data, the fix was
applied via `npm run reshape` — rebuilding from what's already on disk in under
two seconds rather than re-running a 19-minute harvest against their server.

Served from GitHub Pages as static files: free, fast, CDN-backed, zero load on TRC's
WP Engine instance. **Any search that can be expressed as facets never touches their
server.**

### Widget delivery
Single `<script>` tag + a target div. Web Component (`<trc-search>`) with Shadow DOM
so it can't collide with trlibrary.com's CSS, or anyone else's. Attributes for theme,
default collection, result target.

### Multiple widgets — I agree, and here's the split

| Widget | Purpose | Where it fits |
|---|---|---|
| **Quick Search** | One smart box. Type-ahead across all facets at once, showing what kind of match each suggestion is ("Letter · 108,670" / "Creator · Lodge, Henry Cabot"). Enter goes to full results. | Homepage, header, sidebar |
| **Guided / Advanced** | The full faceted experience done right. Progressive disclosure, live counts, chip-based active filters, no dead ends. | A dedicated research page |
| **Featured / Browse** | Curated entry points — "Letters to TR from children," "Panama Canal," "Photographs from the Dakotas." Turns the wall of 139k into a set of doors. | Homepage, landing pages, exhibits |
| **Embed-a-Search** | Take any saved query and drop its live results anywhere. TRC's existing "Share Search" button suggests they already want this. | Blog posts, lesson plans, exhibit pages |

---

## Open questions to resolve next

1. **Where do results land?** Deep-link into theodorerooseveltcenter.org (drives them
   traffic, keeps citation canonical), or render results inline in the widget
   (better UX, keeps the user on trlibrary.com)? This is the biggest fork in the road
   and it's a stakeholder call, not a technical one.
2. **Do we have a relationship with the TRC dev team?** Their `?search=` endpoint
   502ing is a bug on their side. If we can talk to them, a single custom REST route
   would eliminate most of our caching complexity. Worth asking before we engineer
   around it.
3. **Keyword + facet AND behavior** — needs a controlled test.
4. **Does full item text exist in the index, or only metadata?** Determines whether
   "search the archives" means searching descriptions or searching the documents
   themselves. Big difference in user expectation.
5. **Rate limits / terms of use.** We should read their Terms of Use page and, if
   we're going to hit the API on a schedule, tell them we're doing it.

---

## Suggested first step

Build the harvester and run it once. It's low-risk, it's the foundation for every
widget, and the moment we have `creators.json` and `subjects.json` on disk we'll know
exactly what we're working with — real term counts, real file sizes, real data quality.
Everything else is easier to decide with that in hand.
