/**
 * <trc-graph> — embeddable relationship map for the Theodore Roosevelt Center.
 *
 *   <script src="https://trc.labs.trlibrary.com/trc-graph.min.js" defer></script>
 *   <trc-graph></trc-graph>                  <!-- correspondence network -->
 *   <trc-graph mode="subjects"></trc-graph>  <!-- subject constellation -->
 *
 * Opens on Theodore Roosevelt and expands outward as you click, which is the
 * "six degrees" idea made literal. Clicking through to a person or subject
 * deep-links into the TRC's own search in a new tab.
 *
 * ── Why it shows a neighbourhood rather than the whole graph ─────────────────
 *
 * The full people graph is a 700-node hairball dominated by one hub: TR is on
 * 42% of items, so drawing everything at once produces a starburst that
 * communicates nothing. Instead the widget shows one node's neighbourhood at a
 * time and lets you walk outward. That is both more legible and more faithful
 * to how the archive is actually structured.
 *
 * No dependencies. The force simulation is ~40 lines below; pulling in D3 for
 * this would cost 90 KB to save very little.
 */

const TRC = 'https://www.theodorerooseveltcenter.org/digital-library/';
const MAX_VISIBLE = 34;   // beyond this the layout stops being readable
const NEIGHBOURS = 9;     // how many to reveal per expansion

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
.bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--trc-line);flex-wrap:wrap}
.tabs{display:flex;gap:4px}
.tab{font-family:var(--trc-body);font-size:13px;padding:5px 11px;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy-soft);border-radius:var(--trc-radius);cursor:pointer}
.tab[aria-pressed=true]{background:var(--trc-sage);border-color:var(--trc-sage);color:var(--trc-navy);font-weight:700}
.crumb{flex:1;min-width:0;font-size:13px;color:var(--trc-navy-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reset{font-family:var(--trc-body);font-size:13px;background:none;border:0;color:var(--trc-rust);cursor:pointer;padding:4px 2px}
.reset:hover{text-decoration:underline}
svg{display:block;width:100%;height:auto;background:var(--trc-paper);touch-action:manipulation}
.edge{stroke:var(--trc-navy-soft);fill:none}
.node{cursor:pointer}
.node circle{stroke:var(--trc-white);stroke-width:1.5}
.node text{font-family:var(--trc-body);font-size:11px;fill:var(--trc-navy);paint-order:stroke;stroke:var(--trc-paper);stroke-width:3px;stroke-linejoin:round}
.node.root circle{stroke:var(--trc-rust);stroke-width:2.5}
.node.sel circle{stroke:var(--trc-rust);stroke-width:2.5}
.node:focus{outline:none}
.node:focus circle{stroke:var(--trc-rust);stroke-width:3}
.panel{padding:11px 13px;border-top:1px solid var(--trc-line);background:var(--trc-white);font-size:13px}
.panel h3{margin:0 0 3px;font-family:var(--trc-head);font-size:16px;font-weight:700}
.panel .m{color:var(--trc-navy-soft);margin-bottom:8px}
.acts{display:flex;gap:8px;flex-wrap:wrap}
.acts button,.acts a{font-family:var(--trc-body);font-size:13px;padding:5px 11px;border-radius:var(--trc-radius);cursor:pointer;text-decoration:none;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy)}
.acts a{background:var(--trc-sage);border-color:var(--trc-sage);font-weight:700;display:inline-flex;align-items:center;gap:5px}
.acts button:hover,.acts a:hover{border-color:var(--trc-navy-soft)}
.acts svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;display:inline}
.hint{padding:9px 13px;font-size:12.5px;color:var(--trc-navy-soft);border-top:1px solid var(--trc-line)}
.err{padding:16px;font-size:14px;color:var(--trc-navy-soft)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(prefers-color-scheme:dark){
 :host([theme=auto]){
   --trc-navy:#e8ecf2;--trc-navy-soft:#9fb0c6;--trc-rust:#f08a3c;
   --trc-sage:#2c4a44;--trc-paper:#1a1f27;--trc-white:#141922;--trc-line:#33404f;
 }
}
`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Strip the Library of Congress life-date suffix for on-canvas labels. */
const shortName = (n) => {
  const s = String(n).replace(/,\s*\d{3,4}\s*-\s*\d{0,4}\s*$/, '').replace(/\s*\([^)]*\)/, '');
  return s.length > 26 ? `${s.slice(0, 25)}…` : s;
};

class TrcGraph extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.mode = null;
    this.data = {};
    this.visible = [];     // node indices currently drawn
    this.pos = new Map();  // index -> {x, y, vx, vy}
    this.selected = null;
    this.trail = [];
  }

  connectedCallback() {
    this.W = 680; this.H = 400;
    this.shadowRoot.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="bar">
          <div class="tabs">
            <button class="tab" data-mode="people" aria-pressed="true">People</button>
            <button class="tab" data-mode="subjects" aria-pressed="false">Subjects</button>
          </div>
          <span class="crumb"></span>
          <button class="reset" hidden>Start over</button>
        </div>
        <svg viewBox="0 0 ${this.W} ${this.H}" role="img" aria-label="Relationship map"></svg>
        <div class="panel" hidden></div>
        <div class="hint">Loading…</div>
        <p class="sr" role="status" aria-live="polite"></p>
      </div>`;

    if (this.getAttribute('accent')) this.style.setProperty('--trc-rust', this.getAttribute('accent'));

    this.$svg = this.shadowRoot.querySelector('svg');
    this.$panel = this.shadowRoot.querySelector('.panel');
    this.$hint = this.shadowRoot.querySelector('.hint');
    this.$crumb = this.shadowRoot.querySelector('.crumb');
    this.$reset = this.shadowRoot.querySelector('.reset');
    this.$sr = this.shadowRoot.querySelector('.sr');

    this.shadowRoot.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => this.setMode(b.dataset.mode));
    });
    this.$reset.addEventListener('click', () => this.start());

    this.setMode(this.getAttribute('mode') === 'subjects' ? 'subjects' : 'people');
  }

  get base() {
    const b = this.getAttribute('data-base');
    if (b) return b.replace(/\/$/, '');
    const src = TrcGraph._src || document.currentScript?.src || '';
    if (!src) return '.';
    try { return new URL('.', src).href.replace(/\/$/, ''); }
    catch { return src.replace(/\/[^/]*$/, ''); }
  }

  async setMode(mode) {
    this.mode = mode;
    this.shadowRoot.querySelectorAll('.tab').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });

    if (!this.data[mode]) {
      this.$hint.textContent = 'Loading…';
      try {
        const r = await fetch(`${this.base}/data/graph-${mode}.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.placeholder || !d.nodes?.length) {
          // The graphs require the item-fingerprint harvest, which is a separate
          // ~15 minute job. Say so plainly rather than rendering an empty canvas.
          throw new Error(d.note || 'Graph data has not been built yet');
        }
        // Adjacency built once per graph: the widget queries it on every click.
        d.adj = new Map();
        for (const [a, b, w] of d.edges) {
          (d.adj.get(a) ?? d.adj.set(a, []).get(a)).push([b, w]);
          (d.adj.get(b) ?? d.adj.set(b, []).get(b)).push([a, w]);
        }
        for (const list of d.adj.values()) list.sort((x, y) => y[1] - x[1]);
        this.data[mode] = d;
      } catch (err) {
        this.$hint.hidden = true;
        this.$svg.outerHTML = `<div class="err">The relationship map could not be loaded. <a href="${TRC}" target="_blank" rel="noopener">Search the archive directly</a>.</div>`;
        console.warn('[trc-graph] Could not load graph data.', err);
        return;
      }
    }
    this.start();
  }

  get g() { return this.data[this.mode]; }

  /** Open on TR for the people graph, or the densest node for subjects. */
  start() {
    const g = this.g;
    if (!g) return;
    const root = g.root >= 0 ? g.root : 0;
    this.trail = [];
    this.pos.clear();
    this.selected = root;
    this.visible = [root];
    this.expand(root, true);
    this.$reset.hidden = true;
  }

  expand(idx, silent) {
    const g = this.g;
    const neighbours = (g.adj.get(idx) || []).slice(0, NEIGHBOURS).map(([n]) => n);
    const added = neighbours.filter((n) => !this.visible.includes(n));

    for (const n of added) this.visible.push(n);

    // Keep the canvas legible: drop the least-connected nodes furthest from the
    // current selection rather than letting the map silt up.
    if (this.visible.length > MAX_VISIBLE) {
      const keep = new Set([idx, ...neighbours]);
      this.visible = this.visible
        .filter((n, i) => keep.has(n) || i >= this.visible.length - MAX_VISIBLE)
        .slice(-MAX_VISIBLE);
      if (!this.visible.includes(idx)) this.visible.push(idx);
    }

    this.selected = idx;
    if (!silent) {
      const name = g.nodes[idx][1];
      if (this.trail[this.trail.length - 1] !== name) this.trail.push(name);
      if (this.trail.length > 4) this.trail.shift();
      this.$reset.hidden = false;
    }
    this.layout();
    this.render();
    if (!silent) this.announce(`${g.nodes[idx][1]} — ${added.length} new connections shown`);
  }

  /**
   * Force-directed layout.
   *
   * Deterministic: nodes are seeded on a circle by index rather than randomly,
   * so the same click sequence always produces the same picture. A random seed
   * makes the map feel unstable and makes bugs unreproducible.
   */
  layout() {
    const g = this.g;
    const cx = this.W / 2, cy = this.H / 2;
    const vis = this.visible;
    const idx = new Map(vis.map((n, i) => [n, i]));

    vis.forEach((n, i) => {
      if (!this.pos.has(n)) {
        const a = (i / Math.max(vis.length, 1)) * Math.PI * 2;
        const r = n === this.selected ? 0 : 120 + (i % 3) * 34;
        this.pos.set(n, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: 0, vy: 0 });
      }
    });

    const edges = g.edges.filter(([a, b]) => idx.has(a) && idx.has(b));
    const maxW = Math.max(1, ...edges.map((e) => e[2]));

    for (let step = 0; step < 220; step++) {
      // Repulsion — every pair pushes apart, keeping labels from colliding.
      for (let i = 0; i < vis.length; i++) {
        for (let j = i + 1; j < vis.length; j++) {
          const p = this.pos.get(vis[i]), q = this.pos.get(vis[j]);
          let dx = q.x - p.x, dy = q.y - p.y;
          let d2 = dx * dx + dy * dy || 0.01;
          if (d2 > 62500) continue;
          const f = 5200 / d2;
          const d = Math.sqrt(d2);
          const ux = dx / d, uy = dy / d;
          p.vx -= ux * f; p.vy -= uy * f;
          q.vx += ux * f; q.vy += uy * f;
        }
      }
      // Springs — heavier correspondence pulls people closer together.
      for (const [a, b, w] of edges) {
        const p = this.pos.get(a), q = this.pos.get(b);
        const dx = q.x - p.x, dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const rest = 74 + 66 * (1 - w / maxW);
        const f = (d - rest) * 0.014;
        const ux = dx / d, uy = dy / d;
        p.vx += ux * f; p.vy += uy * f;
        q.vx -= ux * f; q.vy -= uy * f;
      }
      // Gentle pull to centre, and pin the selected node so the view is stable.
      for (const n of vis) {
        const p = this.pos.get(n);
        p.vx += (cx - p.x) * 0.006;
        p.vy += (cy - p.y) * 0.006;
        p.vx *= 0.82; p.vy *= 0.82;
        p.x += p.vx; p.y += p.vy;
        p.x = Math.max(58, Math.min(this.W - 58, p.x));
        p.y = Math.max(26, Math.min(this.H - 26, p.y));
      }
      const sel = this.pos.get(this.selected);
      if (sel) { sel.x += (cx - sel.x) * 0.16; sel.y += (cy - sel.y) * 0.16; }
    }
  }

  radius(node) {
    // Area-proportional, so a 58,000-item node doesn't dwarf the canvas.
    return Math.max(6, Math.min(26, 4 + Math.sqrt(node[3]) / 13));
  }

  render() {
    const g = this.g;
    const vis = new Set(this.visible);
    const edges = g.edges.filter(([a, b]) => vis.has(a) && vis.has(b));
    const maxW = Math.max(1, ...edges.map((e) => e[2]));

    const parts = [];
    for (const [a, b, w] of edges) {
      const p = this.pos.get(a), q = this.pos.get(b);
      if (!p || !q) continue;
      const sw = 0.6 + (w / maxW) * 3.4;
      const op = 0.16 + (w / maxW) * 0.4;
      parts.push(`<line class="edge" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke-width="${sw.toFixed(2)}" stroke-opacity="${op.toFixed(2)}"/>`);
    }

    for (const n of this.visible) {
      const node = g.nodes[n];
      const p = this.pos.get(n);
      if (!p) continue;
      const r = this.radius(node);
      const isRoot = n === g.root;
      const isSel = n === this.selected;
      const fill = isSel ? 'var(--trc-rust)' : isRoot ? 'var(--trc-navy)' : 'var(--trc-sage)';
      const cls = `node${isRoot ? ' root' : ''}${isSel ? ' sel' : ''}`;
      parts.push(
        `<g class="${cls}" data-n="${n}" tabindex="0" role="button" aria-label="${esc(node[1])}, ${node[3].toLocaleString()} items">` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>` +
        `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 11).toFixed(1)}" text-anchor="middle">${esc(shortName(node[1]))}</text>` +
        `</g>`,
      );
    }

    this.$svg.innerHTML = parts.join('');
    this.$svg.querySelectorAll('.node').forEach((el) => {
      const n = Number(el.dataset.n);
      el.addEventListener('click', () => this.select(n));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(n); }
      });
    });

    this.$crumb.textContent = this.trail.length > 1 ? this.trail.map(shortName).join(' → ') : '';
    this.renderPanel();
    this.$hint.textContent = this.mode === 'people'
      ? 'Each line is correspondence between two people; thicker means more letters. Click to explore outward.'
      : 'Subjects that appear together on the same item. Roosevelt is left out — he connects to everything.';
  }

  select(n) {
    if (n === this.selected) { this.openAt(n); return; }
    this.expand(n);
  }

  url(n) {
    const node = this.g.nodes[n];
    return `${TRC}?${this.g.param}=${encodeURIComponent(node[2])}`;
  }

  openAt(n) { window.open(this.url(n), '_blank', 'noopener'); }

  renderPanel() {
    const n = this.selected;
    if (n == null) { this.$panel.hidden = true; return; }
    const node = this.g.nodes[n];
    const links = (this.g.adj.get(n) || []).length;
    const unit = this.mode === 'people' ? 'connections' : 'related subjects';
    this.$panel.hidden = false;
    this.$panel.innerHTML = `
      <h3>${esc(node[1])}</h3>
      <div class="m">${node[3].toLocaleString()} items · ${links} ${unit}</div>
      <div class="acts">
        <a href="${esc(this.url(n))}" target="_blank" rel="noopener">
          View at the TR Center
          <svg viewBox="0 0 24 24" stroke-linecap="round"><path d="M7 17L17 7M7 7h10v10"/></svg>
        </a>
        <button data-more>Show more connections</button>
      </div>`;
    const more = this.$panel.querySelector('[data-more]');
    if (more) more.addEventListener('click', () => this.expand(n));
    this.dispatchEvent(new CustomEvent('trc-node', {
      bubbles: true,
      detail: { mode: this.mode, name: node[1], slug: node[2], items: node[3], url: this.url(n) },
    }));
  }

  announce(msg) { this.$sr.textContent = msg; }
}

TrcGraph._src = (document.currentScript && document.currentScript.src) || '';
if (!customElements.get('trc-graph')) customElements.define('trc-graph', TrcGraph);
