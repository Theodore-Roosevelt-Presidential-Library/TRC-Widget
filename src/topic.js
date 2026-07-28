/**
 * <trc-topic> — resource-type breakdown for one subject in the TRC digital library.
 *
 *   <script src="https://trc.labs.trlibrary.com/trc-topic.min.js" defer></script>
 *   <trc-topic name="Conservation of natural resources"></trc-topic>
 *
 * Renders the subject's name and, beneath it, how its items break down by
 * format — Letter (222), Magazine article (21), Cartoon (10)… — each a link that
 * opens that slice in the TRC's own search in a new tab.
 *
 * Attributes:
 *   name     Subject to show. Required. Matched case- and punctuation-
 *            insensitively, so "conservation of natural resources" works too.
 *   limit    Max rows to show before a "Show all" toggle. Default: all.
 *   heading  "off" to omit the subject title (when the page already has one).
 *   accent / theme / data-base   As in the other TRC widgets.
 *
 * The breakdown is precomputed and served as a static shard, so a topic renders
 * with no live calls to the TRC at all — only the click-through hits their site.
 *
 * No dependencies.
 */

import { THEMES } from './themes.js';

const TRC = 'https://www.theodorerooseveltcenter.org/digital-library/';

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
:host{
  all:initial;display:block;
  --trc-navy:#132E52;--trc-navy-soft:#41577a;--trc-rust:#BC4C01;
  --trc-sage:#BED0CE;--trc-paper:#F7F6F2;--trc-line:#dcd8d0;--trc-white:#fff;
  --trc-radius:5px;
  --trc-body:"Nunito Sans",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --trc-head:"Aleo",Georgia,"Times New Roman",serif;
  font-family:var(--trc-body);color:var(--trc-navy);line-height:1.5;
}
:host([theme=inherit]){--trc-body:inherit;--trc-head:inherit}
*{box-sizing:border-box}
.card{background:var(--trc-white);border:1px solid var(--trc-line);border-radius:var(--trc-radius);overflow:hidden}
h3{margin:0;padding:12px 14px 10px;font-family:var(--trc-head);font-size:18px;font-weight:700;border-bottom:1px solid var(--trc-line)}
h3 .tot{font-family:var(--trc-body);font-size:13px;font-weight:400;color:var(--trc-navy-soft);margin-left:6px}
ul{list-style:none;margin:0;padding:0}
li{border-top:1px solid var(--trc-line)}
li:first-child{border-top:0}
a.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;text-decoration:none;color:var(--trc-navy);font-size:14px}
a.row:hover,a.row:focus{background:var(--trc-paper);outline:none}
a.row .n{display:flex;align-items:center;gap:7px;min-width:0}
a.row .n svg{width:13px;height:13px;stroke:var(--trc-navy-soft);fill:none;stroke-width:2;flex:none;opacity:0;transition:opacity .12s}
a.row:hover .n svg,a.row:focus .n svg{opacity:1}
a.row .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.row .c{color:var(--trc-navy-soft);font-variant-numeric:tabular-nums;flex:none}
.more{width:100%;padding:9px 14px;font:inherit;font-size:13px;text-align:left;background:none;border:0;border-top:1px solid var(--trc-line);color:var(--trc-rust);cursor:pointer}
.more:hover{background:var(--trc-paper)}
.all{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-top:2px solid var(--trc-sage);font-size:14px;font-weight:700;text-decoration:none;color:var(--trc-navy)}
.all:hover{background:var(--trc-paper)}
.all svg{width:13px;height:13px;stroke:var(--trc-rust);fill:none;stroke-width:2;flex:none}
.msg{padding:12px 14px;font-size:14px;color:var(--trc-navy-soft)}
@media(prefers-color-scheme:dark){
 :host([theme=auto]){
   --trc-navy:#e8ecf2;--trc-navy-soft:#9fb0c6;--trc-rust:#f08a3c;
   --trc-sage:#2c4a44;--trc-paper:#1a1f27;--trc-white:#141922;--trc-line:#33404f;
 }
}
${THEMES}
`;

const ARROW = '<svg viewBox="0 0 24 24" stroke-linecap="round" aria-hidden="true"><path d="M7 17L17 7M7 7h10v10"/></svg>';

class TrcTopic extends HTMLElement {
  static get observedAttributes() { return ['name', 'limit']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.expanded = false;
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="card"><div class="msg">Loading…</div></div>`;
    if (this.getAttribute('accent')) this.style.setProperty('--trc-rust', this.getAttribute('accent'));
    this.$card = this.shadowRoot.querySelector('.card');
    this.render();
  }

  attributeChangedCallback() { if (this.$card) { this.expanded = false; this.render(); } }

  get base() {
    const b = this.getAttribute('data-base');
    if (b) return b.replace(/\/$/, '');
    const src = TrcTopic._src || document.currentScript?.src || '';
    if (!src) return '.';
    try { return new URL('.', src).href.replace(/\/$/, ''); }
    catch { return src.replace(/\/[^/]*$/, ''); }
  }

  async render() {
    const name = this.getAttribute('name');
    if (!name || !name.trim()) {
      this.$card.innerHTML = `<div class="msg">Add a <code>name</code> attribute, e.g. <code>name="Conservation of natural resources"</code>.</div>`;
      return;
    }

    const key = norm(name);
    const shard = /[a-z]/.test(key[0]) ? key[0] : '_';

    let subjects;
    try {
      // Shards are immutable between weekly rebuilds, so let the browser and CDN
      // cache them hard — several topic embeds on one page share the download.
      const cache = TrcTopic._cache ??= new Map();
      if (!cache.has(shard)) {
        cache.set(shard, fetch(`${this.base}/data/topics/${shard}.json`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }));
      }
      ({ subjects } = await cache.get(shard));
      this.rtNames = (await cache.get(shard)).resourceTypes;
    } catch (err) {
      // No autocomplete to fall back on here, but the subject page still exists —
      // send the reader there rather than showing nothing.
      this.$card.innerHTML = `<div class="msg">Couldn't load this topic. <a href="${TRC}" target="_blank" rel="noopener">Search the archive</a>.</div>`;
      console.warn('[trc-topic] Could not load topic data.', err);
      return;
    }

    const subj = subjects[key];
    if (!subj) {
      this.$card.innerHTML = `<div class="msg">No subject named “${esc(name)}” in the archive. <a href="${esc(TRC)}?keyword=${encodeURIComponent(name)}" target="_blank" rel="noopener">Try a keyword search</a>.</div>`;
      return;
    }

    this.subj = subj;
    this.paint();
    this.dispatchEvent(new CustomEvent('trc-topic', {
      bubbles: true,
      detail: { name: subj.name, slug: subj.slug, total: subj.total, types: subj.rt.length },
    }));
  }

  /** Deep link to this subject, optionally narrowed to one resource type. */
  url(rtName) {
    const p = new URLSearchParams({ subject: this.subj.slug });
    if (rtName) p.set('resource_type', rtName);
    return `${TRC}?${p}`;
  }

  paint() {
    const s = this.subj;
    const limitAttr = parseInt(this.getAttribute('limit'), 10);
    const limit = Number.isFinite(limitAttr) && limitAttr > 0 ? limitAttr : Infinity;
    const rows = this.expanded ? s.rt : s.rt.slice(0, limit);
    const hiddenCount = s.rt.length - rows.length;

    const heading = this.getAttribute('heading') === 'off' ? '' :
      `<h3>${esc(s.name)}<span class="tot">${s.total.toLocaleString()} item${s.total === 1 ? '' : 's'}</span></h3>`;

    const list = rows.map(([ti, n]) => {
      const rt = this.rtNames[ti];
      return `<li><a class="row" href="${esc(this.url(rt))}" target="_blank" rel="noopener">
        <span class="n">${ARROW}<span class="label">${esc(rt)}</span></span>
        <span class="c">${n.toLocaleString()}</span>
      </a></li>`;
    }).join('');

    const more = hiddenCount > 0
      ? `<button class="more">Show ${hiddenCount} more format${hiddenCount === 1 ? '' : 's'}</button>`
      : '';

    // A final link to the whole subject, unfiltered — the reader may want
    // everything, not one format.
    const all = `<a class="all" href="${esc(this.url())}" target="_blank" rel="noopener">
      View all ${s.total.toLocaleString()} at the TR Center ${ARROW}</a>`;

    this.$card.innerHTML = `${heading}<ul>${list}</ul>${more}${all}`;

    const btn = this.$card.querySelector('.more');
    if (btn) btn.addEventListener('click', () => { this.expanded = true; this.paint(); });
  }
}

TrcTopic._src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
if (!customElements.get('trc-topic')) customElements.define('trc-topic', TrcTopic);
