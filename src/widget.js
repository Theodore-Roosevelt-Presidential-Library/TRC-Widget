/**
 * <trc-search> — embeddable search for the Theodore Roosevelt Center digital library.
 *
 * Usage:
 *   <script src="https://USER.github.io/TRC-Widget/trc-search.js" defer></script>
 *   <trc-search></trc-search>
 *
 * Attributes (all optional):
 *   data-base      Base URL for the data files. Defaults to the script's own origin+path.
 *   placeholder    Input placeholder text.
 *   collection     Pre-lock the widget to one collection slug.
 *   accent         CSS color for the accent. Default #7b3f00.
 *   preview        "off" to disable live preview/count requests entirely.
 *
 * Everything renders inside a shadow root, so the host page's CSS can't reach in
 * and ours can't leak out. No dependencies, no build framework, no globals.
 *
 * NOTE: `names.mjs` is inlined above this file at build time by scripts/build.mjs,
 * which is why buildSearchKey/normalize are in scope without an import. Editing
 * the derivation happens there, not here.
 */

const TRC = 'https://www.theodorerooseveltcenter.org';
const API = `${TRC}/wp-json/wp/v2`;
const SEARCH = `${TRC}/digital-library/`;
const TOTAL_ITEMS = 139714;

const REST_TAX = { cr: 'dl_creator', rc: 'dl_recipient', sb: 'dl_subject', cl: 'dl_collection', rt: 'dl_resource_type', pm: 'dl_production_method', pb: 'dl_publication' };
const TAX_FIELDS = Object.values(REST_TAX).join(',');

/**
 * Co-occurrence scanning — how the widget avoids offering dead ends.
 *
 * Once a filter is active, most of the vocabulary is irrelevant: with Henry
 * Cabot Lodge selected, "Diary" matches 41 items overall but zero of his. The
 * old behaviour offered it anyway and dropped the user on an empty result page.
 *
 * Each item's taxonomy fingerprint costs ~63 bytes, so for a narrowed set we can
 * fetch every matching item's term IDs in a handful of requests and know the
 * exact intersection for every possible next filter. After that, typing is
 * instant and the counts shown are real, not estimates.
 *
 * Above the threshold we sample instead, and — importantly — a sample can prove
 * presence but never absence, so sampled scans never hide anything.
 */
const COOC_EXACT_MAX = 600;   // ≤6 requests: full scan, exact counts, hide dead ends
const COOC_SAMPLE_PAGES = 2;  // larger sets: sample only, never hide
const PER_PAGE = 100;

const ICON = {
  cr: 'M12 4a4 4 0 100 8 4 4 0 000-8zM4 20a8 8 0 0116 0',
  rc: 'M3 6h18v12H3zM3 7l9 6 9-6',
  sb: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
  cl: 'M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6',
  rt: 'M6 3h8l4 4v14H6zM14 3v4h4',
  pm: 'M4 20l4-1 10-10-3-3L5 16z',
  pb: 'M4 5h16v14H4zM8 9h8M8 13h5',
};

/**
 * Styling follows the Theodore Roosevelt Center's own design language, so the
 * widget reads as part of their world rather than a bolted-on search box.
 * Sampled from theodorerooseveltcenter.org:
 *
 *   navy   #132E52  body text, headings, links
 *   rust   #BC4C01  secondary/action colour
 *   sage   #BED0CE  primary button fill
 *   paper  #F7F6F2  page background
 *   Aleo (serif) headings · Nunito Sans body · 5px radius
 *
 * Every value is a custom property on :host, so a host page can retheme any
 * single token without forking the widget:
 *
 *   trc-search { --trc-rust: #8c1515; --trc-radius: 0 }
 *
 * Fonts are declared as a stack and never fetched. Loading webfonts from a
 * third party would add a network dependency and a privacy footprint to
 * something that is meant to drop into any page — if the host already serves
 * Aleo and Nunito Sans (as trlibrary.com and the TRC do) they're picked up for
 * free, and the fallback is a clean system stack everywhere else.
 */
const CSS = `
:host{
  all:initial;display:block;
  --trc-navy:#132E52;
  --trc-navy-soft:#41577a;
  --trc-rust:#BC4C01;
  --trc-sage:#BED0CE;
  --trc-paper:#F7F6F2;
  --trc-line:#dcd8d0;
  --trc-line-soft:#e9e5dd;
  --trc-white:#fff;
  --trc-radius:5px;
  --trc-body:"Nunito Sans",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --trc-head:"Aleo",Georgia,"Times New Roman",serif;
  font-family:var(--trc-body);color:var(--trc-navy);line-height:1.5;
}
:host([theme=inherit]){--trc-body:inherit;--trc-head:inherit}
*{box-sizing:border-box}
.wrap{position:relative}
.ib{position:relative}
.ib svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:18px;height:18px;stroke:var(--trc-navy-soft);fill:none;stroke-width:1.75;pointer-events:none}
input{width:100%;height:46px;padding:0 12px 0 40px;font-family:var(--trc-body);font-size:16px;color:var(--trc-navy);background:var(--trc-white);border:1px solid var(--trc-line);border-radius:var(--trc-radius);outline:none}
input:focus{border-color:var(--trc-rust);box-shadow:0 0 0 3px rgba(188,76,1,.16)}
input::placeholder{color:var(--trc-navy-soft);opacity:.75}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:7px;background:var(--trc-sage);color:var(--trc-navy);font-size:13px;padding:5px 8px 5px 10px;border-radius:var(--trc-radius)}
.chip b{font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.chip button{all:unset;cursor:pointer;display:flex;line-height:0;padding:2px;border-radius:3px}
.chip button:hover{background:rgba(19,46,82,.14)}
.chip svg{width:13px;height:13px;stroke:currentColor;stroke-width:2.5;fill:none}
.sugg{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:60;background:var(--trc-white);border:1px solid var(--trc-line);border-radius:var(--trc-radius);box-shadow:0 6px 22px rgba(19,46,82,.15);overflow:hidden;max-height:340px;overflow-y:auto}
.opt{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;background:none;border:0;border-top:1px solid var(--trc-line-soft);font-family:var(--trc-body);font-size:14px;text-align:left;cursor:pointer;color:var(--trc-navy)}
.opt:first-child{border-top:0}
.opt[aria-selected=true]{background:var(--trc-paper)}
.opt svg{width:16px;height:16px;stroke:var(--trc-navy-soft);fill:none;stroke-width:1.75;flex:none}
.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nm mark{background:none;color:var(--trc-rust);font-weight:700}
.fc{font-size:10.5px;color:var(--trc-navy-soft);text-transform:uppercase;letter-spacing:.06em;flex:none}
.ct{font-size:12px;color:var(--trc-navy-soft);flex:none;min-width:50px;text-align:right;font-variant-numeric:tabular-nums}
.empty{padding:12px;font-size:14px;color:var(--trc-navy-soft)}
.pv{margin-top:10px;padding:13px 15px;background:var(--trc-paper);border:1px solid var(--trc-line-soft);border-radius:var(--trc-radius)}
.pvh{display:flex;align-items:baseline;gap:7px;margin-bottom:2px}
.pvn{font-family:var(--trc-head);font-size:25px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.15}
.pvl{font-size:13px;color:var(--trc-navy-soft)}
.it{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--trc-line-soft);font-size:13px}
.it:first-of-type{margin-top:9px}
.it i{width:3px;background:var(--trc-sage);border-radius:2px;flex:none}
.it .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it .m{font-size:12px;color:var(--trc-navy-soft)}
.go{display:inline-flex;align-items:center;gap:6px;margin-top:11px;font-size:14px;font-weight:700;color:var(--trc-rust);text-decoration:none}
.go:hover{text-decoration:underline}
.go svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2}
.err{font-size:13px;color:var(--trc-navy-soft);margin-top:8px}
.flash{font-size:13px;color:var(--trc-navy);background:var(--trc-sage);border-radius:var(--trc-radius);padding:6px 10px;margin-top:8px}
.swap{font-size:10.5px;color:var(--trc-rust);text-transform:uppercase;letter-spacing:.06em;flex:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* Their site is light-only, and so is trlibrary.com. Auto-inverting on a light
   host page would look broken, so dark mode is opt-in via theme="auto". */
@media(prefers-color-scheme:dark){
 :host([theme=auto]){
   --trc-navy:#e8ecf2;--trc-navy-soft:#9fb0c6;--trc-rust:#f08a3c;
   --trc-sage:#2c4a44;--trc-paper:#1a1f27;--trc-white:#141922;
   --trc-line:#33404f;--trc-line-soft:#2a3441;
 }
}
`;

/**
 * Rank a candidate against the typed query.
 *
 * A hard "prefix matches first, then by count" sort looks reasonable and is
 * wrong: typing "theodore roosevelt" put Theodore Roosevelt National Park
 * (2,932 items) above Roosevelt, Theodore the person (58,180), because the park
 * happened to match at position zero. Nobody typing that name wants the park.
 *
 * So position is a multiplier on magnitude rather than a gate. Log-scaling the
 * count keeps a 58k-item term from burying every mid-sized exact match.
 */
function score(t, nq) {
  const k = t.k;
  let pos = 1;
  if (k.startsWith(nq)) pos = 2.6;
  else if (k.includes(`| ${nq}`)) pos = 2.2;      // starts one of the name variants
  if (k === nq || k.startsWith(`${nq} |`)) pos = 3.4; // exact match on a variant
  return pos * Math.log10(Math.max(t.count, 1) + 1);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

class TrcSearch extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.index = null;
    this.chips = [];
    this.matches = [];
    this.cursor = -1;
    this.seq = 0;
  }

  connectedCallback() {
    const ph = this.getAttribute('placeholder') || 'Search 139,714 items — try “Lodge”, “cartoon”, “Panama”';
    this.shadowRoot.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="ib">
          ${svg('M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4')}
          <input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
                 aria-label="Search the Theodore Roosevelt Center digital library"
                 autocomplete="off" spellcheck="false" placeholder="${esc(ph)}">
        </div>
        <div class="chips" role="list"></div>
        <div class="flash" hidden></div>
        <div class="sugg" role="listbox" hidden></div>
        <div class="pv"></div>
        <p class="sr" role="status" aria-live="polite"></p>
      </div>`;

    const accent = this.getAttribute('accent');
    if (accent) this.style.setProperty('--trc-rust', accent);

    this.$in = this.shadowRoot.querySelector('input');
    this.$sugg = this.shadowRoot.querySelector('.sugg');
    this.$chips = this.shadowRoot.querySelector('.chips');
    this.$flash = this.shadowRoot.querySelector('.flash');
    this.$pv = this.shadowRoot.querySelector('.pv');
    this.$sr = this.shadowRoot.querySelector('.sr');

    this.$in.addEventListener('input', () => this.onInput());
    this.$in.addEventListener('keydown', (e) => this.onKey(e));
    this.$in.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    this.$in.addEventListener('focus', () => { if (this.$in.value.trim()) this.onInput(); });

    this.renderPreview();
    this.load();
  }

  /**
   * Where to load the index from.
   *
   * Resolved to an absolute URL from the script's own src, because the widget
   * is normally embedded on a different origin than the one hosting it — the
   * bundle is served from trc.labs.trlibrary.com but runs on trlibrary.com, so
   * a relative "data/head.json" would resolve against the host page and 404.
   *
   * GitHub Pages sends Access-Control-Allow-Origin: *, so the cross-origin
   * fetch of our own data is fine.
   */
  get base() {
    const b = this.getAttribute('data-base');
    if (b) return b.replace(/\/$/, '');
    const src = TrcSearch._src || document.currentScript?.src || '';
    if (!src) return '.';
    try { return new URL('.', src).href.replace(/\/$/, ''); }
    catch { return src.replace(/\/[^/]*$/, ''); }
  }

  async load() {
    try {
      const r = await fetch(`${this.base}/data/head.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      this.facets = d.facets;
      // Derive search keys once at load — ~4k terms, a few milliseconds.
      this.index = d.terms.map(([f, name, value, count, id]) => ({
        f, name, value, count, id, k: buildSearchKey(name),
      }));
      if (this.$in.value.trim()) this.onInput();
    } catch (err) {
      // Autocomplete is an enhancement. Without it the widget still submits a
      // keyword search to the TRC, so a data failure must never break the box.
      this.index = [];
      this.degraded = true;
      console.warn(
        `[trc-search] Could not load the search index from ${this.base}/data/head.json — ` +
        'suggestions are disabled but the search box still works. ' +
        'If this widget is embedded on another domain, check that the host serves ' +
        'Access-Control-Allow-Origin, or set data-base to a reachable path.',
        err,
      );
      this.renderPreview();
    }
  }

  search(q) {
    const nq = normalize(q);
    if (!nq || !this.index) return [];
    const taken = new Set(this.chips.map((c) => c.f + c.value));
    const co = this.cooc;
    const out = [];
    for (const t of this.index) {
      if (taken.has(t.f + t.value)) continue;
      const i = t.k.indexOf(nq);
      if (i === -1) continue;
      // Word-boundary only: "lodge" must not match "Blodgett".
      if (i > 0 && !/[\s|]/.test(t.k[i - 1])) continue;

      let count = t.count;
      if (co) {
        const n = co.counts.get(t.id);
        if (co.exact) {
          // We know the full intersection — drop anything that would land the
          // user on an empty page, and show the true combined count.
          if (!n) continue;
          count = n;
        } else if (n) {
          count = null; // seen in the sample; real total unknown
        }
      }
      out.push({ t, count, s: score(t, nq) });
      if (out.length > 400) break;
    }
    return out.sort((a, b) => b.s - a.s).slice(0, 8).map((o) => ({ ...o.t, count: o.count }));
  }

  onInput() {
    const q = this.$in.value;
    this.matches = this.search(q);
    this.cursor = -1;
    if (!q.trim()) return this.close();

    if (!this.matches.length) {
      let msg;
      if (!this.index?.length) msg = 'Press Enter to search the Theodore Roosevelt Center.';
      else if (this.cooc?.exact) msg = 'Nothing matching that also appears in your current results. Remove a filter to widen the search.';
      else msg = 'No matching people, subjects or types. Press Enter to search the full text instead.';
      this.$sugg.innerHTML = `<div class="empty">${msg}</div>`;
      this.open();
      return;
    }

    const nq = normalize(q);
    this.$sugg.innerHTML = this.matches.map((t, i) => {
      const j = normalize(t.name).indexOf(nq);
      let nm = esc(t.name);
      if (j > -1) {
        // Highlight against the display string, guarding against the offset
        // drift normalization can introduce on punctuation-heavy names.
        const raw = t.name.toLowerCase().indexOf(q.trim().toLowerCase());
        if (raw > -1) {
          const e = raw + q.trim().length;
          nm = `${esc(t.name.slice(0, raw))}<mark>${esc(t.name.slice(raw, e))}</mark>${esc(t.name.slice(e))}`;
        }
      }
      return `<button class="opt" role="option" id="o${i}" aria-selected="false" data-i="${i}">
        ${svg(ICON[t.f] || ICON.sb)}
        <span class="nm">${nm}</span>
        <span class="fc">${esc(this.facets?.[t.f]?.label || '')}</span>
        ${this.chips.some((c) => c.f === t.f)
          ? '<span class="swap">replaces</span>'
          : `<span class="ct">${t.count == null ? '·' : t.count.toLocaleString()}</span>`}
      </button>`;
    }).join('');

    this.$sugg.querySelectorAll('.opt').forEach((b) => {
      b.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(+b.dataset.i); });
    });
    this.open();
    this.announce(`${this.matches.length} suggestions`);
  }

  onKey(e) {
    const n = this.matches.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); this.move((this.cursor + 1) % n); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); this.move((this.cursor - 1 + n) % n); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.cursor > -1) this.pick(this.cursor);
      else this.submit();
    } else if (e.key === 'Escape') { this.close(); this.$in.blur(); }
    else if (e.key === 'Backspace' && !this.$in.value && this.chips.length) {
      this.chips.pop(); this.sync();
    }
  }

  move(i) {
    this.cursor = i;
    this.$sugg.querySelectorAll('.opt').forEach((b, j) => {
      const on = j === i;
      b.setAttribute('aria-selected', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
    this.$in.setAttribute('aria-activedescendant', `o${i}`);
  }

  pick(i) {
    const t = this.matches[i];
    if (!t) return;

    // One filter per facet — enforced by the destination, not by preference.
    //
    // The TRC search form takes a single value per parameter. Passing two
    // subjects as ?subject=a&subject=b silently keeps only the last (verified:
    // North Dakota + Thank-you notes returned 7,266 — the Thank-you notes total,
    // with North Dakota dropped). Comma-joining is worse: their form reads it as
    // one nonsense term and falls back to all 139,714 results.
    //
    // Their WordPress also rejects the REST AND-relation syntax, and a
    // comma-separated term list means OR, not AND. So there is no combination
    // of two same-facet terms we could offer that their site would honour.
    // Replacing is the only option that keeps the preview and the destination
    // telling the same story.
    const prev = this.chips.findIndex((c) => c.f === t.f);
    const replaced = prev > -1 ? this.chips[prev] : null;
    if (replaced) this.chips.splice(prev, 1);

    this.chips.push(t);
    this.$in.value = '';
    this.close();
    this.sync();
    this.$in.focus();

    const label = this.facets?.[t.f]?.label || 'filter';
    this.flash(replaced
      ? `${label} changed to ${t.name} — replaced ${replaced.name}`
      : `Added ${label}: ${t.name}`);

    this.dispatchEvent(new CustomEvent('trc-filter', { bubbles: true, detail: { filters: this.chips.map((c) => ({ facet: this.facets?.[c.f]?.label, name: c.name })), url: this.url(), replaced: replaced ? replaced.name : null } }));
  }

  sync() {
    this.renderChips();
    this.renderPreview();
    this.fetchPreview();
    this.scanCooccurrence();
  }

  /**
   * Query string identifying the current filter set, for REST calls and caching.
   *
   * Uses set(), never append(). Appending produced ?dl_subject=a&dl_subject=b,
   * which PHP collapses to the last value — the filter silently vanished and the
   * count shown was for one term while the user believed they had applied two.
   * With one chip per facet this can't arise, but set() makes that structural
   * rather than a thing to remember.
   */
  filterQuery() {
    const p = new URLSearchParams();
    for (const c of this.chips) {
      const tax = REST_TAX[c.f];
      if (tax && c.id) p.set(tax, c.id);
    }
    return p;
  }

  /**
   * Scan the active result set and record which terms actually co-occur with it.
   *
   * Runs once per filter change, not per keystroke. Aborts cleanly if the user
   * changes filters mid-scan, and caches by filter set so removing and re-adding
   * a chip costs nothing.
   */
  async scanCooccurrence() {
    this._scan?.abort();
    if (!this.chips.length || this.getAttribute('preview') === 'off') {
      this.cooc = null;
      return;
    }

    const key = this.chips.map((c) => c.f + c.id).sort().join(',');
    this._coocCache ??= new Map();
    if (this._coocCache.has(key)) {
      this.cooc = this._coocCache.get(key);
      if (this.$in.value.trim()) this.onInput();
      return;
    }

    const ctrl = new AbortController();
    this._scan = ctrl;
    const base = this.filterQuery();
    base.set('_fields', TAX_FIELDS);
    base.set('per_page', String(PER_PAGE));

    const counts = new Map();
    const tally = (rows) => {
      for (const item of rows) {
        for (const tax of Object.values(REST_TAX)) {
          const ids = item[tax];
          if (!Array.isArray(ids)) continue;
          for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
        }
      }
    };

    try {
      base.set('page', '1');
      const first = await fetch(`${API}/digital-library?${base}`, { signal: ctrl.signal });
      if (!first.ok) throw new Error(`HTTP ${first.status}`);
      const total = Number(first.headers.get('x-wp-total')) || 0;
      tally(await first.json());

      const exact = total > 0 && total <= COOC_EXACT_MAX;
      const lastPage = exact
        ? Math.ceil(total / PER_PAGE)
        : Math.min(COOC_SAMPLE_PAGES, Math.ceil(total / PER_PAGE));

      for (let page = 2; page <= lastPage; page++) {
        base.set('page', String(page));
        const r = await fetch(`${API}/digital-library?${base}`, { signal: ctrl.signal });
        if (!r.ok) break;
        tally(await r.json());
      }

      // A partial scan can prove a term is present but never that it's absent,
      // so only a complete scan is allowed to hide suggestions.
      this.cooc = { counts, exact, total };
      this._coocCache.set(key, this.cooc);
      if (this.$in.value.trim()) this.onInput();
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Their API is unreliable. Losing the scan costs refinement quality, not
      // function — fall back to unfiltered suggestions.
      this.apiFail(err, 'Co-occurrence scan');
      this.cooc = null;
    }
  }

  renderChips() {
    this.$chips.innerHTML = this.chips.map((c, i) => `
      <span class="chip" role="listitem">
        <b>${esc(this.facets?.[c.f]?.label || '')}</b>${esc(c.name)}
        <button data-i="${i}" aria-label="Remove ${esc(c.name)}">${svg('M6 6l12 12M18 6L6 18')}</button>
      </span>`).join('');
    this.$chips.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { this.chips.splice(+b.dataset.i, 1); this.sync(); });
    });
  }

  url() {
    const p = new URLSearchParams();
    const kw = this.$in.value.trim();
    if (kw && !this.chips.length) p.set('keyword', kw);
    const lock = this.getAttribute('collection');
    if (lock) p.set('collection', lock);
    for (const c of this.chips) {
      const param = this.facets?.[c.f]?.param;
      if (param) p.set(param, c.value);
    }
    return `${SEARCH}?${p.toString()}`;
  }

  submit() { window.open(this.url(), '_blank', 'noopener'); }

  renderPreview(count, items, loading) {
    if (!this.chips.length) {
      this.$pv.innerHTML = `<div class="pvh"><span class="pvn">${TOTAL_ITEMS.toLocaleString()}</span><span class="pvl">items across 52 collections</span></div>
        <div class="pvl">Start typing to narrow by person, subject, collection or format.</div>
        ${this.degraded ? '<p class="err">Suggestions are unavailable right now — you can still press Enter to search.</p>' : ''}`;
      return;
    }
    const head = count == null
      ? `<div class="pvh"><span class="pvl">${loading ? 'Counting…' : 'Matching items'}</span></div>`
      : `<div class="pvh"><span class="pvn">${count.toLocaleString()}</span><span class="pvl">matching item${count === 1 ? '' : 's'}</span></div>`;
    const list = (items || []).map((it) => `
      <div class="it"><i></i><div>
        <div class="t">${esc(it.title)}</div>
        <div class="m">${esc(it.meta)}</div>
      </div></div>`).join('');
    this.$pv.innerHTML = `${head}${list}
      <a class="go" href="${esc(this.url())}" target="_blank" rel="noopener">
        View ${count == null ? 'results' : `all ${count.toLocaleString()}`} at the TR Center
        ${svg('M7 17L17 7M7 7h10v10')}
      </a>`;
  }

  async fetchPreview() {
    if (!this.chips.length || this.getAttribute('preview') === 'off') return;
    const seq = ++this.seq;
    clearTimeout(this._t);
    this._t = setTimeout(async () => {
      this.renderPreview(null, null, true);
      const p = this.filterQuery();
      p.set('per_page', '3');
      p.set('_fields', 'title,link,date');
      p.set('orderby', 'date');
      p.set('order', 'desc');
      try {
        const r = await fetch(`${API}/digital-library?${p}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const total = Number(r.headers.get('x-wp-total'));
        const rows = await r.json();
        if (seq !== this.seq) return;
        this.renderPreview(
          Number.isFinite(total) ? total : null,
          rows.map((x) => ({
            title: (x.title?.rendered || 'Untitled').replace(/<[^>]+>/g, ''),
            meta: (x.date || '').slice(0, 10),
          })),
        );
      } catch (err) {
        // Their API 502s intermittently. Fall back to the link.
        this.apiFail(err, 'Preview request');
        if (seq === this.seq) this.renderPreview();
      }
    }, 280);
  }

  /**
   * Report a failed call to the TRC API.
   *
   * Everything live (count, preview, co-occurrence) is a cross-origin request
   * to theodorerooseveltcenter.org. WordPress sends Access-Control-Allow-Origin
   * by default, but a security plugin or WAF rule can strip it — in which case
   * fetch rejects with a bare TypeError and no status, indistinguishable from
   * the site being down unless we say so.
   *
   * Since these features fail soft by design, without this note a CORS block
   * would look like "the previews just never show up" and be hard to diagnose.
   * Warns once per page, never throws.
   */
  apiFail(err, what) {
    if (err?.name === 'AbortError') return;
    if (TrcSearch._warned) return;
    TrcSearch._warned = true;
    const likelyCors = err instanceof TypeError && !/HTTP \d/.test(err.message || '');
    console.warn(
      `[trc-search] ${what} failed. ` +
      (likelyCors
        ? 'This looks like a CORS block or network failure — the Theodore Roosevelt Center API did not return permissive CORS headers to this origin. Live counts and previews are disabled; autocomplete and deep links still work.'
        : `The TRC API returned an error (${err?.message || err}). This is usually transient — their server 502s under load.`),
    );
  }

  announce(msg) { this.$sr.textContent = msg; }

  /** Brief visible + screen-reader note. Used when a filter silently replaces another. */
  flash(msg) {
    this.announce(msg);
    if (!/replaced/.test(msg)) { this.$flash.hidden = true; return; }
    this.$flash.textContent = msg;
    this.$flash.hidden = false;
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { this.$flash.hidden = true; }, 4000);
  }
  open() { this.$sugg.hidden = false; this.$in.setAttribute('aria-expanded', 'true'); }
  close() { this.$sugg.hidden = true; this.$in.setAttribute('aria-expanded', 'false'); this.$in.removeAttribute('aria-activedescendant'); this.cursor = -1; }
}

TrcSearch._src = (document.currentScript && document.currentScript.src) || '';
if (!customElements.get('trc-search')) customElements.define('trc-search', TrcSearch);
