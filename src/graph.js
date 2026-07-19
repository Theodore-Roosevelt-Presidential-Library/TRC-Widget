/**
 * <trc-graph> — relationship map for the Theodore Roosevelt Center digital library.
 *
 *   <script src="https://trc.labs.trlibrary.com/trc-graph.min.js" defer></script>
 *   <trc-graph></trc-graph>                  <!-- correspondence network -->
 *   <trc-graph mode="subjects"></trc-graph>  <!-- subject constellation -->
 *
 * Shows the whole network at once — ~1,600 people or subjects — then lets you
 * zoom, search and click through to the TRC's own search.
 *
 * ── Why the entire graph, and how it stays fast ─────────────────────────────
 *
 * The first version simulated forces in the browser and could therefore only
 * afford a 10-node neighbourhood at a time. That made the map a keyhole: you
 * could walk the network but never see it, and "how big is this archive" — the
 * question the visualisation exists to answer — went unanswered.
 *
 * Layout is now precomputed at build time (scripts/graph.mjs) and baked into the
 * data as x/y. The browser runs no simulation at all, which is what makes
 * drawing everything affordable. Rendering is split by what each technology is
 * good at:
 *
 *   canvas  edges — up to ~17,000 of them, redrawn on zoom, alpha-blended so
 *           density reads as tone rather than as a solid mat of lines
 *   svg     nodes — a few thousand, needing hit-testing, focus and ARIA
 *
 * Only d3-zoom and d3-selection are bundled; d3-force runs at build time.
 */

import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';

const TRC = 'https://www.theodorerooseveltcenter.org/digital-library/';

/**
 * Cluster palette.
 *
 * Muted and low-contrast on purpose: these sit behind ~1,600 overlapping dots,
 * and a saturated categorical scheme at that density reads as confetti. The
 * colours only need to separate neighbouring regions, not be identifiable in
 * isolation — the legend and the panel carry the actual naming. Anchored around
 * the TRC's navy/sage/rust so the map still looks like their site.
 */
const PALETTE = ['#41577a', '#7a9e94', '#b4713a', '#6b6a94', '#8a9a5b',
                 '#a2647a', '#4f8296', '#9c8248', '#6f7d8c', '#b0b7bd'];

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
.wrap{position:relative;background:var(--trc-paper);border:1px solid var(--trc-line);border-radius:var(--trc-radius);overflow:hidden}
.bar{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--trc-line);flex-wrap:wrap}
.tabs{display:flex;gap:4px}
.tab{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy-soft);border-radius:var(--trc-radius);cursor:pointer}
.tab[aria-pressed=true]{background:var(--trc-sage);border-color:var(--trc-sage);color:var(--trc-navy);font-weight:700}
.find{flex:1;min-width:130px;position:relative}
.find input{width:100%;height:30px;padding:0 9px;font:inherit;font-size:13px;color:var(--trc-navy);background:var(--trc-white);border:1px solid var(--trc-line);border-radius:var(--trc-radius);outline:none}
.find input:focus{border-color:var(--trc-rust)}
.hits{position:absolute;left:0;right:0;top:34px;z-index:40;background:var(--trc-white);border:1px solid var(--trc-line);border-radius:var(--trc-radius);box-shadow:0 6px 20px rgba(19,46,82,.16);max-height:220px;overflow-y:auto}
.hits button{display:flex;justify-content:space-between;gap:10px;width:100%;padding:7px 10px;font:inherit;font-size:13px;text-align:left;background:none;border:0;border-top:1px solid var(--trc-line);cursor:pointer;color:var(--trc-navy)}
.hits button:first-child{border-top:0}
.hits button:hover{background:var(--trc-paper)}
.hits .c{color:var(--trc-navy-soft);font-size:12px;flex:none}
.count{font-size:12.5px;color:var(--trc-navy-soft)}
.showall{font:inherit;font-size:12.5px;padding:4px 10px;border:1px solid var(--trc-rust);background:var(--trc-white);color:var(--trc-rust);border-radius:var(--trc-radius);cursor:pointer;white-space:nowrap}
.showall:hover{background:var(--trc-rust);color:var(--trc-white)}
.alt{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--trc-navy);cursor:pointer;user-select:none}
.alt input{margin:0;accent-color:var(--trc-rust)}
.stage{position:relative;height:520px;overflow:hidden;cursor:grab;background:var(--trc-paper)}
.stage.grabbing{cursor:grabbing}
canvas,svg{position:absolute;inset:0;width:100%;height:100%}
svg{touch-action:none}
.node{cursor:pointer}
.node circle{stroke:var(--trc-white);stroke-width:.8}
.node text{font-family:var(--trc-body);font-size:11px;fill:var(--trc-navy);pointer-events:none;paint-order:stroke;stroke:var(--trc-paper);stroke-width:3px;stroke-linejoin:round}
.node.sel circle{stroke:var(--trc-rust);stroke-width:2.5}
.node.sel text{font-weight:700}
.node:focus{outline:none}
.node:focus circle{stroke:var(--trc-rust);stroke-width:2.5}
.faded{opacity:.12}
.ctx circle{opacity:.3}
.ctx text{display:none}
.panel{padding:11px 13px;border-top:1px solid var(--trc-line);background:var(--trc-white);font-size:13px}
.panel h3{margin:0 0 3px;font-family:var(--trc-head);font-size:16px;font-weight:700}
.panel .m{color:var(--trc-navy-soft);margin-bottom:8px}
.acts{display:flex;gap:8px;flex-wrap:wrap}
.acts a,.acts button{font:inherit;font-size:13px;padding:5px 11px;border-radius:var(--trc-radius);cursor:pointer;text-decoration:none;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy)}
.acts a{background:var(--trc-sage);border-color:var(--trc-sage);font-weight:700;display:inline-flex;align-items:center;gap:5px}
.acts a:hover,.acts button:hover{border-color:var(--trc-navy-soft)}
.acts svg{position:static;width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2}
.hint{padding:8px 13px;font-size:12.5px;color:var(--trc-navy-soft);border-top:1px solid var(--trc-line)}
.zoomer{position:absolute;right:9px;bottom:9px;display:flex;flex-direction:column;gap:4px;z-index:20}
.legend{position:absolute;left:9px;bottom:9px;z-index:20;display:flex;flex-wrap:wrap;gap:4px 9px;max-width:62%;font-size:11px;color:var(--trc-navy-soft)}
.legend span{display:inline-flex;align-items:center;gap:4px}
.legend i{width:9px;height:9px;border-radius:50%;display:inline-block}
:host(:fullscreen) .wrap,:host(:-webkit-full-screen) .wrap{height:100vh;display:flex;flex-direction:column;border:0;border-radius:0}
:host(:fullscreen) .stage,:host(:-webkit-full-screen) .stage{flex:1;height:auto}
.zoomer button{width:27px;height:27px;font:inherit;font-size:15px;line-height:1;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy);border-radius:var(--trc-radius);cursor:pointer}
.zoomer button:hover{border-color:var(--trc-navy-soft)}
.err{padding:16px;font-size:14px;color:var(--trc-navy-soft)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(prefers-color-scheme:dark){
 :host([theme=auto]){
   --trc-navy:#e8ecf2;--trc-navy-soft:#9fb0c6;--trc-rust:#f08a3c;
   --trc-sage:#2c4a44;--trc-paper:#1a1f27;--trc-white:#141922;--trc-line:#33404f;
 }
}
`;

const shortName = (n) => {
  const s = String(n).replace(/,\s*\d{3,4}\s*-\s*\d{0,4}\s*$/, '').replace(/\s*\([^)]*\)/, '');
  return s.length > 26 ? `${s.slice(0, 25)}…` : s;
};
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class TrcGraph extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.data = {};
    this.selected = null;
    this.hover = null;
    this.t = zoomIdentity;
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="bar">
          <div class="tabs">
            <button class="tab" data-mode="people" aria-pressed="true">People</button>
            <button class="tab" data-mode="subjects" aria-pressed="false">Subjects</button>
          </div>
          <div class="find">
            <input type="text" placeholder="Find someone…" aria-label="Find in the map" autocomplete="off" spellcheck="false">
            <div class="hits" hidden></div>
          </div>
          <label class="alt" hidden><input type="checkbox"> <span></span></label>
          <button class="showall" hidden>Show all</button>
          <span class="count"></span>
        </div>
        <div class="stage">
          <canvas></canvas>
          <svg role="img" aria-label="Relationship map"></svg>
          <div class="zoomer">
            <button data-z="in" aria-label="Zoom in">+</button>
            <button data-z="out" aria-label="Zoom out">−</button>
            <button data-z="fit" aria-label="Fit to view">⤢</button>
            <button data-z="full" aria-label="Full screen" title="Full screen">⛶</button>
          </div>
          <div class="legend"></div>
        </div>
        <div class="panel" hidden></div>
        <div class="hint">Loading…</div>
        <p class="sr" role="status" aria-live="polite"></p>
      </div>`;

    if (this.getAttribute('accent')) this.style.setProperty('--trc-rust', this.getAttribute('accent'));
    if (this.getAttribute('height')) this.shadowRoot.querySelector('.stage').style.height = this.getAttribute('height');

    this.$stage = this.shadowRoot.querySelector('.stage');
    this.$canvas = this.shadowRoot.querySelector('canvas');
    this.$svg = this.shadowRoot.querySelector('svg');
    this.$panel = this.shadowRoot.querySelector('.panel');
    this.$hint = this.shadowRoot.querySelector('.hint');
    this.$count = this.shadowRoot.querySelector('.count');
    this.$find = this.shadowRoot.querySelector('.find input');
    this.$hits = this.shadowRoot.querySelector('.hits');
    this.$legend = this.shadowRoot.querySelector('.legend');
    this.$showAll = this.shadowRoot.querySelector('.showall');
    this.$showAll.addEventListener('click', () => this.clearFocus());
    this.$alt = this.shadowRoot.querySelector('.alt');
    this.$altBox = this.$alt.querySelector('input');
    this.$sr = this.shadowRoot.querySelector('.sr');

    this.$altBox.addEventListener('change', () => this.setAlt(this.$altBox.checked));

    this.shadowRoot.querySelectorAll('.tab').forEach((b) =>
      b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    this.shadowRoot.querySelectorAll('[data-z]').forEach((b) =>
      b.addEventListener('click', () => this.doZoom(b.dataset.z)));
    this.$find.addEventListener('input', () => this.runFind());
    this.$find.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.clearFocus(); });
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.filter || this.selected != null)) this.clearFocus();
    });
    this.$find.addEventListener('blur', () => setTimeout(() => { this.$hits.hidden = true; }, 150));

    this.setupStage();
    this.setMode(this.getAttribute('mode') === 'subjects' ? 'subjects' : 'people');

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.$stage);
  }

  disconnectedCallback() { this._ro?.disconnect(); }

  get base() {
    const b = this.getAttribute('data-base');
    if (b) return b.replace(/\/$/, '');
    const src = TrcGraph._src || document.currentScript?.src || '';
    if (!src) return '.';
    try { return new URL('.', src).href.replace(/\/$/, ''); }
    catch { return src.replace(/\/[^/]*$/, ''); }
  }

  setupStage() {
    const svg = select(this.$svg);
    this.gNodes = svg.append('g');

    this.zoomer = zoom().scaleExtent([0.55, 14]).on('zoom', (e) => {
      this.t = e.transform;
      this.gNodes.attr('transform', e.transform);
      this.drawEdges();
      this.updateLabels();
    });
    svg.call(this.zoomer).on('dblclick.zoom', null);
    svg.on('pointerdown', () => this.$stage.classList.add('grabbing'));
    select(document).on('pointerup.trcgraph', () => this.$stage.classList.remove('grabbing'));
    // Clicking empty canvas clears the focus.
    svg.on('click', () => this.selectNode(null));
  }

  /**
   * Read the stage size and size the canvas backing store.
   *
   * Separated from resize() because ordering matters on a mode switch: the fit
   * scale needs the dimensions, renderNodes needs the fit scale, and resize
   * measures the bound selection. Folding all of that into one method made the
   * dependency implicit, and got it wrong.
   */
  measure() {
    const r = this.$stage.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.$canvas.width = this.W * dpr;
    this.$canvas.height = this.H * dpr;
    // getContext returns null where canvas is unsupported or unimplemented
    // (JSDOM, some locked-down embeds). Nodes and interaction still work; only
    // the edge layer is lost, so degrade rather than throw.
    try { this.ctx = this.$canvas.getContext('2d'); } catch { this.ctx = null; }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.$svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
  }

  /** Re-measure and redraw. Used by the ResizeObserver and on entering fullscreen. */
  resize() {
    this.measure();
    if (!this.g) return;
    this.computeFit();
    this.renderNodes();
    this.drawEdges();
    this.updateLabels();
  }

  async setMode(mode) {
    this.mode = mode;
    this.shadowRoot.querySelectorAll('.tab').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    this.$find.placeholder = mode === 'people' ? 'Find someone…' : 'Find a subject…';

    if (!this.data[mode]) {
      this.$hint.textContent = 'Loading…';
      try {
        const r = await fetch(`${this.base}/data/graph-${mode}.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.placeholder || !d.nodes?.length) throw new Error(d.note || 'Graph data has not been built yet');
        if (!d.layout) throw new Error('Graph data predates precomputed layout — rerun `npm run graphs`');

        d.adj = new Map();
        for (const [a, b, w] of d.edges) {
          (d.adj.get(a) ?? d.adj.set(a, []).get(a)).push([b, w]);
          (d.adj.get(b) ?? d.adj.set(b, []).get(b)).push([a, w]);
        }
        for (const list of d.adj.values()) list.sort((x, y) => y[1] - x[1]);
        d.maxW = Math.max(1, ...d.edges.map((e) => e[2]));
        d.xi = d.fields.nodes.indexOf('x');
        d.yi = d.fields.nodes.indexOf('y');
        d.x2i = d.fields.nodes.indexOf('x2');
        d.y2i = d.fields.nodes.indexOf('y2');
        d.ci = d.fields.nodes.indexOf('cluster');
        d.key = d.nodes.map((n) => norm(n[1]));
        this.data[mode] = d;
      } catch (err) {
        this.$hint.hidden = true;
        this.$stage.innerHTML = `<div class="err">The relationship map could not be loaded. <a href="${TRC}" target="_blank" rel="noopener">Search the archive directly</a>.</div>`;
        console.warn('[trc-graph] Could not load graph data.', err);
        return;
      }
    }

    this.selected = this.g.root >= 0 ? this.g.root : null;
    this.hover = null;
    this.$find.value = '';
    this.$hits.hidden = true;
    // Explicit order: measure, then fit, then bind, then draw.
    this.measure();
    this.computeFit();
    this.renderNodes();
    select(this.$svg).call(this.zoomer.transform, zoomIdentity);
    this.drawEdges();
    this.updateLabels();
    this.renderPanel();

    this.renderLegend();
    const hasAlt = !!this.g.altLayout && this.g.x2i > -1;
    this.$alt.hidden = !hasAlt;
    if (hasAlt) this.$alt.querySelector('span').textContent = this.g.altLayout.label;
    this.$altBox.checked = false;
    this.alt = false;
    this.updateCount();
    this.$hint.textContent = this.mode === 'people'
      ? 'Click anyone to focus on them and their correspondents. Search to narrow the map, “Show all” or Escape to return.'
      : 'Subjects appearing together on the same item. Click one to focus; Roosevelt is omitted — he connects to everything.';
  }

  get g() { return this.data[this.mode]; }

  /** Map layout coordinates into stage pixels, preserving aspect ratio. */
  computeFit() {
    const { w, h } = this.g.layout;
    const pad = 34;
    this.k = Math.min((this.W - pad * 2) / w, (this.H - pad * 2) / h);
    this.ox = (this.W - w * this.k) / 2;
    this.oy = (this.H - h * this.k) / 2;
  }

  /** Community colour, or the brand navy for Roosevelt himself. */
  colourOf(i) {
    const g = this.g;
    if (i === g.root) return 'var(--trc-navy)';
    if (g.ci < 0) return 'var(--trc-sage)';
    const c = g.nodes[i][g.ci];
    // The isolated group isn't a community — it's everyone with no relationship
    // to anyone but Roosevelt. Giving it a palette colour would imply a shared
    // identity it doesn't have, so it takes a neutral grey and reads as ground.
    if (c === g.isolatedCluster) return '#c3c7cb';
    return PALETTE[c % PALETTE.length];
  }

  /** Coordinate set in use: the full layout, or the one with the hub removed. */
  sx(n) { return this.ox + n[this.alt ? this.g.x2i : this.g.xi] * this.k; }
  sy(n) { return this.oy + n[this.alt ? this.g.y2i : this.g.yi] * this.k; }

  /** Edges hidden in "without Roosevelt" view, and nodes left isolated by it. */
  isHidden(i) {
    if (this.alt && i === this.g.altLayout?.excludes) return true;
    if (this.filter && !this.filter.show.has(i)) return true;
    return false;
  }

  setAlt(on) {
    this.alt = on;
    if (this.selected != null && this.isHidden(this.selected)) this.selected = null;
    this.renderNodes();
    this.applyFocus();
    this.drawEdges();
    this.renderPanel();
    this.updateCount();
    this.announce(on
      ? 'Roosevelt hidden — showing how everyone else connects'
      : 'Showing the full network');
  }

  updateCount() {
    const g = this.g;
    // The reset only appears once there's something to reset — an always-present
    // "Show all" on an unfiltered map is noise.
    if (this.$showAll) this.$showAll.hidden = !(this.filter || this.selected != null);
    if (this.filter) {
      const n = this.filter.match.size;
      this.$count.textContent = `${n.toLocaleString()} match${n === 1 ? '' : 'es'} shown`;
      return;
    }
    const hidden = this.alt ? g.edges.filter(([a, b]) => a === g.altLayout.excludes || b === g.altLayout.excludes).length : 0;
    const nodes = g.nodes.length - (this.alt ? 1 : 0);
    this.$count.textContent =
      `${nodes.toLocaleString()} ${this.mode === 'people' ? 'people' : 'subjects'} · ${(g.edges.length - hidden).toLocaleString()} links`;
  }
  /**
   * Node radius in screen pixels.
   *
   * Deliberately NOT multiplied by the fit scale. Doing that shrank the median
   * node to ~1.2px — technically proportional, practically invisible. Size
   * should encode item count, not how much of the layout happens to be on
   * screen, so it stays in screen units and only responds to zoom.
   */
  radius(n) { return Math.max(2.2, Math.min(26, 1.8 + Math.sqrt(n[3]) / 7)); }

  /**
   * Edges on canvas.
   *
   * The subject graph has ~17,000 links. As SVG that's 17,000 live DOM nodes to
   * create and restyle; on canvas it's one path pass per frame. Alpha is kept
   * low so overlapping links build up tone — density becomes something you can
   * read rather than a solid mat.
   */
  drawEdges() {
    if (!this.ctx || !this.g) return;
    const { ctx } = this;
    const t = this.t;
    ctx.clearRect(0, 0, this.W, this.H);

    const g = this.g;
    const focus = this.hover ?? this.selected;
    const near = focus == null ? null : new Set([focus, ...(g.adj.get(focus) || []).map(([o]) => o)]);

    const style = getComputedStyle(this);
    const soft = style.getPropertyValue('--trc-navy-soft').trim() || '#41577a';
    const rust = style.getPropertyValue('--trc-rust').trim() || '#BC4C01';

    // Below a certain zoom the weakest links are visual noise, so thin them out
    // until the reader zooms in far enough for them to mean something.
    const minW = t.k < 1.4 ? 3 : t.k < 3 ? 2 : 0;

    ctx.lineCap = 'round';
    for (const [a, b, w] of g.edges) {
      if (this.isHidden(a) || this.isHidden(b)) continue;
      if (w < minW && !(near && (near.has(a) && near.has(b)))) continue;
      const na = g.nodes[a], nb = g.nodes[b];
      const x1 = t.applyX(this.sx(na)), y1 = t.applyY(this.sy(na));
      const x2 = t.applyX(this.sx(nb)), y2 = t.applyY(this.sy(nb));
      // Cheap viewport cull — most edges are off-screen when zoomed in.
      if ((x1 < 0 && x2 < 0) || (x1 > this.W && x2 > this.W) ||
          (y1 < 0 && y2 < 0) || (y1 > this.H && y2 > this.H)) continue;

      const rel = w / g.maxW;
      const hot = near && (a === focus || b === focus);
      if (near && !hot) { ctx.globalAlpha = 0.05; ctx.strokeStyle = soft; }
      else if (hot) { ctx.globalAlpha = 0.85; ctx.strokeStyle = rust; }
      else { ctx.globalAlpha = 0.1 + rel * 0.34; ctx.strokeStyle = soft; }

      ctx.lineWidth = Math.max(0.35, (0.4 + rel * 3) * Math.min(t.k, 3));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  renderNodes() {
    const g = this.g;
    // Keyed by mode as well as index. Keying on the index alone meant switching
    // tabs matched node 0 of People to node 0 of Subjects and reused the DOM,
    // so radii and labels stayed stale from the previous graph.
    const sel = this.gNodes.selectAll('g.node')
      .data(g.nodes.map((n, i) => i), (i) => `${this.mode}-${i}`);
    sel.exit().remove();
    const enter = sel.enter().append('g').attr('tabindex', 0).attr('role', 'button');
    enter.append('circle');
    enter.append('text').attr('text-anchor', 'middle');

    const self = this;
    this.nodeSel = enter.merge(sel)
      .attr('class', 'node')
      .attr('transform', (i) => `translate(${this.sx(g.nodes[i])},${this.sy(g.nodes[i])})`)
      .attr('aria-label', (i) => `${g.nodes[i][1]}, ${g.nodes[i][3].toLocaleString()} items`)
      .on('click', function (e, i) { e.stopPropagation(); self.selectNode(i); })
      .on('keydown', function (e, i) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.selectNode(i); }
      })
      .on('pointerenter', (e, i) => { this.hover = i; this.drawEdges(); this.applyFocus(); })
      .on('pointerleave', () => { this.hover = null; this.drawEdges(); this.applyFocus(); });

    this.nodeSel.attr('display', (i) => this.isHidden(i) ? 'none' : null)
      // Context nodes stay visible but recede so the actual matches read first.
      .classed('ctx', (i) => !!this.filter && !this.filter.match.has(i));
    this.nodeSel.select('circle')
      .attr('r', (i) => this.radius(g.nodes[i]))
      .attr('fill', (i) => this.colourOf(i));
    this.nodeSel.select('text')
      .attr('y', (i) => this.radius(g.nodes[i]) + 11)
      .text((i) => shortName(g.nodes[i][1]));
  }

  /**
   * Label thinning.
   *
   * 1,600 labels at once is unreadable, and hiding all but a handful makes the
   * map feel empty. Instead the on-screen size of each node decides: big hubs
   * are named at any zoom, smaller ones surface as you move in. The map stays
   * legible at every scale and rewards exploration.
   */
  updateLabels() {
    // The bound selection can briefly belong to the previous graph during a mode
    // switch. Measuring it against the new one reads past the end of the node
    // array, so bail until renderNodes has rebound it.
    if (!this.nodeSel || this.nodeSel.size() !== this.g?.nodes.length) return;
    const g = this.g;
    const k = this.t.k;
    const focus = this.hover ?? this.selected;

    // Label the focus and its *strongest* neighbours only.
    //
    // The previous rule labelled every neighbour of the focused node. With
    // Roosevelt selected by default that meant 1,503 labels at once, which is
    // what turned the map into a solid mat of text. A hub's neighbourhood has
    // to be capped or the rule destroys the view it's meant to clarify.
    const near = new Map();
    if (focus != null) {
      near.set(focus, Infinity);
      for (const [o, w] of (g.adj.get(focus) || []).slice(0, 12)) near.set(o, w);
    }

    this.nodeSel.select('text').attr('display', (i) => {
      // While filtering, name every match — the set is small by construction.
      if (this.filter) return this.filter.match.has(i) ? null : 'none';
      if (near.has(i)) return null;
      // Otherwise label by on-screen prominence, so hubs are named at any zoom
      // and smaller names surface as the reader moves in.
      return this.radius(g.nodes[i]) * k >= 9 ? null : 'none';
    });
    this.nodeSel.select('text').attr('font-size', `${Math.min(13, 11 / Math.max(k, 0.6))}px`);
    this.nodeSel.select('circle').attr('stroke-width', 0.8 / Math.max(k, 1));
  }

  neighbours(i) {
    const list = (this.g.adj.get(i) || []).map(([o]) => o);
    return this.alt ? list.filter((o) => !this.isHidden(o)) : list;
  }

  applyFocus() {
    if (!this.nodeSel || this.nodeSel.size() !== this.g?.nodes.length) return;
    const focus = this.hover ?? this.selected;
    const near = focus == null ? null : new Set([focus, ...this.neighbours(focus)]);
    this.nodeSel
      .classed('faded', (i) => !!near && !near.has(i))
      .classed('sel', (i) => i === this.selected);
    this.updateLabels();
  }

  selectNode(i) {
    // Clicking the background clears everything and returns to the full map.
    if (i == null) { if (this.filter || this.selected != null) this.clearFocus(); return; }
    this.focusOn(i);
  }

  /**
   * Frame a set of nodes so all of them are on screen.
   *
   * Replaces a fixed 3.2× zoom-to-centre, which was the wrong tool twice over:
   * it cut off the very neighbourhood the reader had just selected, and the
   * amount of surrounding graph you saw depended on nothing more meaningful than
   * how spread out that particular cluster happened to be. Fitting the bounding
   * box means the answer always fills the window and never overflows it.
   */
  fitTo(indices, duration = 480) {
    const pts = indices.map((i) => this.g.nodes[i]).filter(Boolean);
    if (!pts.length) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of pts) {
      const x = this.sx(n), y = this.sy(n), r = this.radius(n);
      minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
    }

    // Padding leaves room for labels, which sit below each node and extend
    // sideways well past the circle itself.
    const padX = 90, padY = 54;
    const w = Math.max(1, maxX - minX) + padX * 2;
    const h = Math.max(1, maxY - minY) + padY * 2;

    const [kMin, kMax] = this.zoomer.scaleExtent();
    const k = Math.max(kMin, Math.min(kMax, Math.min(this.W / w, this.H / h)));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const t = zoomIdentity.translate(this.W / 2 - cx * k, this.H / 2 - cy * k).scale(k);

    select(this.$svg).transition().duration(duration).call(this.zoomer.transform, t);
  }

  /**
   * Select a node and frame its neighbourhood.
   *
   * Selecting a search result used to clear the filter and zoom to a fixed
   * scale, which put the entire 1,592-node map back on screen at 3.2× — undoing
   * the filtering the reader had just done. Selecting anything now narrows to
   * that node and its strongest ties, and fits them to the window.
   */
  focusOn(i, { fit = true } = {}) {
    const g = this.g;
    const near = [i, ...(g.adj.get(i) || []).slice(0, 14).map(([o]) => o)];
    this.filter = { match: new Set([i]), show: new Set(near) };
    this.selected = i;
    this.hover = null;
    this.renderNodes();
    this.applyFocus();
    this.drawEdges();
    this.updateCount();
    this.renderPanel();
    if (fit) this.fitTo(near.filter((n) => !this.isHidden(n)));
    this.announce(`${g.nodes[i][1]}, showing ${near.length - 1} connections`);
  }

  /** Drop any filter and return to the whole network. */
  clearFocus() {
    this.filter = null;
    this.selected = null;
    this.$find.value = '';
    this.$hits.hidden = true;
    this.renderNodes();
    this.applyFocus();
    this.drawEdges();
    this.updateCount();
    this.renderPanel();
    select(this.$svg).transition().duration(340).call(this.zoomer.transform, zoomIdentity);
  }

  /**
   * Filter the map to what matches the query.
   *
   * Highlighting alone doesn't help at this density — a dozen emphasised dots
   * inside 1,600 others is still a haystack. Hiding non-matches turns the search
   * box into a way of carving the network down to a question. Direct neighbours
   * of a match stay visible but muted, because a lone dot with its edges removed
   * tells you nothing about how that person sat in the archive.
   */
  applyFilter(matches) {
    const g = this.g;
    if (!matches || !matches.length) { this.filter = null; }
    else {
      const keep = new Set(matches);
      const ctx = new Set(matches);
      // Only each match's strongest few neighbours count as context. Taking all
      // of them meant searching "roosevelt" pulled in his 1,503 correspondents
      // and left 1,515 nodes on screen — a filter that filtered nothing.
      for (const i of matches) {
        for (const [o] of (g.adj.get(i) || []).slice(0, 8)) ctx.add(o);
      }
      this.filter = { match: keep, show: ctx };
    }
    this.renderNodes();
    this.applyFocus();
    this.drawEdges();
    this.updateCount();
  }

  runFind() {
    const q = norm(this.$find.value.trim());
    if (!q) { this.$hits.hidden = true; this.applyFilter(null); return; }
    const g = this.g;
    const out = [];
    for (let i = 0; i < g.key.length && out.length < 40; i++) {
      const at = g.key[i].indexOf(q);
      if (at === -1) continue;
      if (at > 0 && !/[\s,(]/.test(g.key[i][at - 1])) continue;
      out.push(i);
    }
    out.sort((a, b) => g.nodes[b][3] - g.nodes[a][3]);
    this.applyFilter(out);
    const top = out.slice(0, 8);
    if (!top.length) {
      this.$hits.innerHTML = '<button disabled style="color:var(--trc-navy-soft)">Not in the top connections shown here</button>';
      this.$hits.hidden = false;
      return;
    }
    this.$hits.innerHTML = top.map((i) =>
      `<button data-i="${i}"><span>${esc(g.nodes[i][1])}</span><span class="c">${g.nodes[i][3].toLocaleString()}</span></button>`).join('');
    this.$hits.querySelectorAll('[data-i]').forEach((b) => {
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const i = Number(b.dataset.i);
        this.$hits.hidden = true;
        this.$find.value = '';
        this.focusOn(i);
      });
    });
    this.$hits.hidden = false;
  }

  /**
   * Full screen.
   *
   * The element itself goes fullscreen rather than the stage, so the shadow root
   * — and therefore all the widget's styling — comes with it. Requesting it on
   * an inner div would leave the controls unstyled against a black backdrop.
   * The ResizeObserver already handles refitting, so nothing else is needed.
   */
  async toggleFullscreen() {
    const doc = this.ownerDocument;
    try {
      if (doc.fullscreenElement === this || doc.webkitFullscreenElement === this) {
        await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      } else {
        await (this.requestFullscreen?.() ?? this.webkitRequestFullscreen?.());
      }
    } catch {
      // Fullscreen is refused inside some sandboxed iframes without
      // allow="fullscreen". Not worth an error state; the map still works.
      this.announce('Full screen is not available here');
    }
  }

  doZoom(kind) {
    if (kind === 'full') return this.toggleFullscreen();
    const svg = select(this.$svg);
    if (kind === 'fit') { svg.transition().duration(340).call(this.zoomer.transform, zoomIdentity); return; }
    svg.transition().duration(220).call(this.zoomer.scaleBy, kind === 'in' ? 1.6 : 1 / 1.6);
  }

  url(n, param) { return `${TRC}?${param || this.g.param}=${encodeURIComponent(this.g.nodes[n][2])}`; }

  /**
   * A node is a person; the TRC's search is per-role.
   *
   * Someone appears as both creator and recipient under two term IDs with
   * different counts, and ?creator= and ?recipient= are separate searches.
   * Showing one combined figure beside a single-role link misreports the
   * archive — TR's node once read "30,656 items" next to a link returning
   * 58,180 — so each role gets its own link and its own count.
   */
  roleLinks(n) {
    const node = this.g.nodes[n];
    const roles = this.g.roleParams;
    if (!roles) return [{ label: 'View at the TR Center', href: this.url(n) }];
    const out = [];
    const wrote = node[5], received = node[6];
    if (wrote) out.push({ label: `Wrote (${wrote.toLocaleString()})`, href: this.url(n, roles.wrote) });
    if (received) out.push({ label: `Received (${received.toLocaleString()})`, href: this.url(n, roles.received) });
    return out.length ? out : [{ label: 'View at the TR Center', href: this.url(n) }];
  }

  renderPanel() {
    const n = this.selected;
    if (n == null) {
      this.$panel.hidden = false;
      this.$panel.innerHTML = `<div class="m">Click anyone in the map to see who they wrote to and open their letters at the TR Center.</div>`;
      return;
    }
    const node = this.g.nodes[n];
    const links = (this.g.adj.get(n) || []);
    const top = links.slice(0, 3).map(([o, w]) => `${shortName(this.g.nodes[o][1])} (${w})`).join(', ');
    const unit = this.mode === 'people' ? 'connections' : 'related subjects';
    const arrow = '<svg viewBox="0 0 24 24" stroke-linecap="round"><path d="M7 17L17 7M7 7h10v10"/></svg>';
    this.$panel.hidden = false;
    this.$panel.innerHTML = `
      <h3>${esc(node[1])}</h3>
      <div class="m">${node[3].toLocaleString()} items · ${links.length} ${unit}${top ? ` · strongest: ${esc(top)}` : ''}</div>
      <div class="acts">
        ${this.roleLinks(n).map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}${arrow}</a>`).join('')}
      </div>`;
    this.dispatchEvent(new CustomEvent('trc-node', {
      bubbles: true,
      detail: { mode: this.mode, name: node[1], slug: node[2], items: node[3], url: this.url(n) },
    }));
  }

  /**
   * Legend naming each community by its largest member.
   *
   * A colour key that reads "Cluster 3" is decoration. Naming each group after
   * its heaviest node — "Corbin", "Loeb" — tells the reader what the region of
   * the map actually is, which is the whole reason for colouring it.
   */
  renderLegend() {
    const g = this.g;
    if (g.ci < 0) { this.$legend.innerHTML = ''; return; }
    const best = new Map();
    g.nodes.forEach((n, i) => {
      if (i === g.root) return;
      const c = n[g.ci];
      const cur = best.get(c);
      if (!cur || n[3] > g.nodes[cur][3]) best.set(c, i);
    });
    const size = new Map();
    for (const n of g.nodes) size.set(n[g.ci], (size.get(n[g.ci]) || 0) + 1);

    const iso = g.isolatedCluster;
    const entries = [...best.entries()]
      .filter(([c]) => c !== iso)
      .sort((a, b) => (size.get(b[0]) || 0) - (size.get(a[0]) || 0))
      .slice(0, 5)
      .map(([c, i]) =>
        `<span><i style="background:${PALETTE[c % PALETTE.length]}"></i>${esc(shortName(g.nodes[i][1]))}</span>`);

    // Named explicitly rather than by its largest member: "Burroughs" would
    // suggest a community around him, when in fact none of these people are
    // connected to each other at all.
    if (size.get(iso) && g.isolatedLabel) {
      entries.push(`<span><i style="background:#c3c7cb"></i>${esc(g.isolatedLabel)} (${size.get(iso).toLocaleString()})</span>`);
    }
    this.$legend.innerHTML = entries.join('');
  }

  announce(msg) { this.$sr.textContent = msg; }
}

TrcGraph._src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
if (!customElements.get('trc-graph')) customElements.define('trc-graph', TrcGraph);
