/**
 * <trc-graph> — relationship map for the Theodore Roosevelt Center digital library.
 *
 *   <script src="https://trc.labs.trlibrary.com/trc-graph.min.js" defer></script>
 *   <trc-graph></trc-graph>                  <!-- correspondence network -->
 *   <trc-graph mode="subjects"></trc-graph>  <!-- subject constellation -->
 *
 * Opens on Theodore Roosevelt and expands outward as you click. Clicking a
 * selected node opens the TRC's own search for that person or subject.
 *
 * ── On the D3 dependency ────────────────────────────────────────────────────
 *
 * The rest of this project is dependency-free, and the first version of this
 * widget hand-rolled its force layout to keep it that way. That was the wrong
 * call: a graph layout is precisely the thing not to hand-roll. d3-force brings
 * velocity Verlet integration, a Barnes-Hut quadtree, collision resolution and
 * proper alpha cooling — all of which I approximated badly in 40 lines.
 *
 * The needed modules are *bundled at build time*, not fetched from a CDN. An
 * embeddable widget that breaks when jsdelivr is blocked isn't embeddable, and
 * institutional networks block plenty. Cost is ~21 KB gzipped, which buys a
 * live simulation, dragging, zooming and collision-free labels.
 */

import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';

const TRC = 'https://www.theodorerooseveltcenter.org/digital-library/';
const NEIGHBOURS = 10;   // revealed per expansion
const MAX_VISIBLE = 60;  // collision + zoom make this comfortable now

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
.tab{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy-soft);border-radius:var(--trc-radius);cursor:pointer}
.tab[aria-pressed=true]{background:var(--trc-sage);border-color:var(--trc-sage);color:var(--trc-navy);font-weight:700}
.crumb{flex:1;min-width:0;font-size:13px;color:var(--trc-navy-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reset{font:inherit;font-size:13px;background:none;border:0;color:var(--trc-rust);cursor:pointer;padding:4px 2px}
.reset:hover{text-decoration:underline}
.stage{position:relative;height:460px;cursor:grab}
.stage.grabbing{cursor:grabbing}
svg{display:block;width:100%;height:100%;touch-action:none}
.edge{stroke:var(--trc-navy-soft);fill:none;transition:stroke-opacity .18s,stroke .18s}
.edge.hot{stroke:var(--trc-rust)}
.node{cursor:pointer}
.node circle{stroke:var(--trc-white);stroke-width:1.5;transition:opacity .18s}
.node text{font-family:var(--trc-body);font-size:11px;fill:var(--trc-navy);pointer-events:none;paint-order:stroke;stroke:var(--trc-paper);stroke-width:3.5px;stroke-linejoin:round;transition:opacity .18s}
.node.root circle,.node.sel circle{stroke:var(--trc-rust);stroke-width:2.5}
.node.sel text{font-weight:700}
.node:focus{outline:none}
.node:focus circle{stroke:var(--trc-rust);stroke-width:3}
.dim{opacity:.13}
.panel{padding:11px 13px;border-top:1px solid var(--trc-line);background:var(--trc-white);font-size:13px}
.panel h3{margin:0 0 3px;font-family:var(--trc-head);font-size:16px;font-weight:700}
.panel .m{color:var(--trc-navy-soft);margin-bottom:8px}
.acts{display:flex;gap:8px;flex-wrap:wrap}
.acts button,.acts a{font:inherit;font-size:13px;padding:5px 11px;border-radius:var(--trc-radius);cursor:pointer;text-decoration:none;border:1px solid var(--trc-line);background:var(--trc-white);color:var(--trc-navy)}
.acts a{background:var(--trc-sage);border-color:var(--trc-sage);font-weight:700;display:inline-flex;align-items:center;gap:5px}
.acts button:hover,.acts a:hover{border-color:var(--trc-navy-soft)}
.acts svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;display:inline;height:13px}
.hint{padding:9px 13px;font-size:12.5px;color:var(--trc-navy-soft);border-top:1px solid var(--trc-line)}
.zoomer{position:absolute;right:9px;bottom:9px;display:flex;flex-direction:column;gap:4px}
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
@media(prefers-reduced-motion:reduce){.edge,.node circle,.node text{transition:none}}
`;

/** Strip Library of Congress life dates and parentheticals for on-canvas labels. */
const shortName = (n) => {
  const s = String(n).replace(/,\s*\d{3,4}\s*-\s*\d{0,4}\s*$/, '').replace(/\s*\([^)]*\)/, '');
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
};

class TrcGraph extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.data = {};
    this.visible = new Set();
    this.selected = null;
    this.trail = [];
    this.fixed = new Map();  // node index -> {x, y} for dragged-and-pinned nodes
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
          <span class="crumb"></span>
          <button class="reset" hidden>Start over</button>
        </div>
        <div class="stage">
          <svg role="img" aria-label="Relationship map"></svg>
          <div class="zoomer">
            <button data-z="in" aria-label="Zoom in">+</button>
            <button data-z="out" aria-label="Zoom out">−</button>
            <button data-z="fit" aria-label="Reset view">⤢</button>
          </div>
        </div>
        <div class="panel" hidden></div>
        <div class="hint">Loading…</div>
        <p class="sr" role="status" aria-live="polite"></p>
      </div>`;

    if (this.getAttribute('accent')) this.style.setProperty('--trc-rust', this.getAttribute('accent'));
    if (this.getAttribute('height')) this.shadowRoot.querySelector('.stage').style.height = this.getAttribute('height');

    this.$stage = this.shadowRoot.querySelector('.stage');
    this.$svg = this.shadowRoot.querySelector('svg');
    this.$panel = this.shadowRoot.querySelector('.panel');
    this.$hint = this.shadowRoot.querySelector('.hint');
    this.$crumb = this.shadowRoot.querySelector('.crumb');
    this.$reset = this.shadowRoot.querySelector('.reset');
    this.$sr = this.shadowRoot.querySelector('.sr');

    this.shadowRoot.querySelectorAll('.tab').forEach((b) =>
      b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    this.$reset.addEventListener('click', () => this.start());
    this.shadowRoot.querySelectorAll('[data-z]').forEach((b) =>
      b.addEventListener('click', () => this.doZoom(b.dataset.z)));

    this.setupSvg();
    this.setMode(this.getAttribute('mode') === 'subjects' ? 'subjects' : 'people');

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.$stage);
  }

  disconnectedCallback() {
    this._ro?.disconnect();
    this.sim?.stop();
  }

  get base() {
    const b = this.getAttribute('data-base');
    if (b) return b.replace(/\/$/, '');
    const src = TrcGraph._src || document.currentScript?.src || '';
    if (!src) return '.';
    try { return new URL('.', src).href.replace(/\/$/, ''); }
    catch { return src.replace(/\/[^/]*$/, ''); }
  }

  setupSvg() {
    const svg = select(this.$svg);
    this.gRoot = svg.append('g');
    this.gEdges = this.gRoot.append('g');
    this.gNodes = this.gRoot.append('g');

    this.zoomer = zoom().scaleExtent([0.35, 3.5]).on('zoom', (e) => {
      this.gRoot.attr('transform', e.transform);
    });
    svg.call(this.zoomer).on('dblclick.zoom', null);

    svg.on('pointerdown', () => this.$stage.classList.add('grabbing'));
    select(document).on('pointerup.trcgraph', () => this.$stage.classList.remove('grabbing'));
  }

  resize() {
    const r = this.$stage.getBoundingClientRect();
    this.W = r.width || 680;
    this.H = r.height || 460;
    this.$svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    if (this.sim) {
      this.sim.force('x', forceX(this.W / 2).strength(0.045));
      this.sim.force('y', forceY(this.H / 2).strength(0.055));
      this.sim.alpha(0.3).restart();
    }
  }

  async setMode(mode) {
    this.mode = mode;
    this.shadowRoot.querySelectorAll('.tab').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));

    if (!this.data[mode]) {
      this.$hint.textContent = 'Loading…';
      try {
        const r = await fetch(`${this.base}/data/graph-${mode}.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.placeholder || !d.nodes?.length) throw new Error(d.note || 'Graph data has not been built yet');
        d.adj = new Map();
        for (const [a, b, w] of d.edges) {
          (d.adj.get(a) ?? d.adj.set(a, []).get(a)).push([b, w]);
          (d.adj.get(b) ?? d.adj.set(b, []).get(b)).push([a, w]);
        }
        for (const list of d.adj.values()) list.sort((x, y) => y[1] - x[1]);
        this.data[mode] = d;
      } catch (err) {
        this.$hint.hidden = true;
        this.$stage.innerHTML = `<div class="err">The relationship map could not be loaded. <a href="${TRC}" target="_blank" rel="noopener">Search the archive directly</a>.</div>`;
        console.warn('[trc-graph] Could not load graph data.', err);
        return;
      }
    }
    this.resize();
    this.start();
  }

  get g() { return this.data[this.mode]; }

  start() {
    const g = this.g;
    if (!g) return;
    this.visible = new Set();
    this.fixed.clear();
    this.trail = [];
    this.nodeState = new Map();
    const root = g.root >= 0 ? g.root : 0;
    this.selected = root;
    this.visible.add(root);
    this.$reset.hidden = true;
    // Seed the trail with the starting node so the first click reads
    // "Roosevelt → Taft" rather than appearing from nowhere.
    this.trail = [g.nodes[root][1]];
    select(this.$svg).call(this.zoomer.transform, zoomIdentity);
    this.expand(root, true);
  }

  expand(idx, silent) {
    const g = this.g;
    const neighbours = (g.adj.get(idx) || []).slice(0, NEIGHBOURS).map(([n]) => n);
    const before = this.visible.size;

    // Seed newcomers near the node they came from, so the simulation resolves
    // outward instead of exploding from the origin.
    const from = this.nodeState?.get(idx);
    for (const n of neighbours) {
      if (this.visible.has(n)) continue;
      this.visible.add(n);
      if (from && !this.nodeState.has(n)) {
        const a = Math.random() * Math.PI * 2;
        this.nodeState.set(n, { x: from.x + Math.cos(a) * 60, y: from.y + Math.sin(a) * 60 });
      }
    }

    // Trim the oldest arrivals rather than letting the canvas silt up, but never
    // drop the current node, its neighbours, or anything the user pinned.
    if (this.visible.size > MAX_VISIBLE) {
      const protect = new Set([idx, ...neighbours, ...this.fixed.keys()]);
      const order = [...this.visible];
      for (const n of order) {
        if (this.visible.size <= MAX_VISIBLE) break;
        if (!protect.has(n)) this.visible.delete(n);
      }
    }

    this.selected = idx;
    if (!silent) {
      const name = g.nodes[idx][1];
      if (this.trail[this.trail.length - 1] !== name) this.trail.push(name);
      if (this.trail.length > 5) this.trail.shift();
      this.$reset.hidden = false;
    }
    this.render();
    if (!silent) {
      this.announce(`${g.nodes[idx][1]} — ${this.visible.size - before} new connections shown`);
    }
  }

  radius(node) {
    // Area-proportional: a 58,000-item node shouldn't be 1,400× the area of a
    // 40-item one, or it swallows the canvas.
    return Math.max(6, Math.min(30, 4.5 + Math.sqrt(node[3]) / 11));
  }

  render() {
    const g = this.g;
    const vis = [...this.visible];
    const idxOf = new Map(vis.map((n, i) => [n, i]));

    // d3-force mutates node objects, so carry positions across re-renders by
    // reusing the same object per node index.
    this.nodeState ??= new Map();
    const nodes = vis.map((n) => {
      const s = this.nodeState.get(n) ?? { x: this.W / 2 + (Math.random() - 0.5) * 80, y: this.H / 2 + (Math.random() - 0.5) * 80 };
      s.i = n;
      s.r = this.radius(g.nodes[n]);
      const pin = this.fixed.get(n);
      if (pin) { s.fx = pin.x; s.fy = pin.y; } else { s.fx = null; s.fy = null; }
      this.nodeState.set(n, s);
      return s;
    });

    const links = g.edges
      .filter(([a, b]) => idxOf.has(a) && idxOf.has(b))
      .map(([a, b, w]) => ({ source: this.nodeState.get(a), target: this.nodeState.get(b), w }));

    const maxW = Math.max(1, ...links.map((l) => l.w));

    this.sim?.stop();
    this.sim = forceSimulation(nodes)
      .force('link', forceLink(links)
        // Heavier correspondence pulls people closer and holds them more firmly.
        .distance((l) => 46 + 74 * (1 - l.w / maxW))
        .strength((l) => 0.25 + 0.55 * (l.w / maxW)))
      .force('charge', forceManyBody().strength(-260).distanceMax(420))
      .force('collide', forceCollide().radius((d) => d.r + 13).iterations(2))
      .force('x', forceX(this.W / 2).strength(0.045))
      .force('y', forceY(this.H / 2).strength(0.055))
      .alpha(0.9)
      .alphaDecay(0.028);

    const edgeSel = this.gEdges.selectAll('line').data(links, (d) => `${d.source.i}-${d.target.i}`);
    edgeSel.exit().remove();
    const edgeEnter = edgeSel.enter().append('line').attr('class', 'edge');
    this.edges = edgeEnter.merge(edgeSel)
      .attr('stroke-width', (d) => 0.7 + (d.w / maxW) * 4)
      .attr('stroke-opacity', (d) => 0.15 + (d.w / maxW) * 0.42);

    const nodeSel = this.gNodes.selectAll('g.node').data(nodes, (d) => d.i);
    nodeSel.exit().remove();
    const enter = nodeSel.enter().append('g')
      .attr('tabindex', 0)
      .attr('role', 'button');
    enter.append('circle');
    enter.append('text').attr('text-anchor', 'middle');

    this.nodes = enter.merge(nodeSel)
      .attr('class', (d) => `node${d.i === g.root ? ' root' : ''}${d.i === this.selected ? ' sel' : ''}`)
      .attr('aria-label', (d) => `${g.nodes[d.i][1]}, ${g.nodes[d.i][3].toLocaleString()} items`);

    this.nodes.select('circle')
      .attr('r', (d) => d.r)
      .attr('fill', (d) => d.i === this.selected ? 'var(--trc-rust)'
        : d.i === g.root ? 'var(--trc-navy)' : 'var(--trc-sage)');

    this.nodes.select('text')
      .attr('y', (d) => d.r + 12)
      .text((d) => shortName(g.nodes[d.i][1]));

    const self = this;
    this.nodes
      .on('click', function (e, d) { e.stopPropagation(); self.select(d.i); })
      .on('keydown', function (e, d) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.select(d.i); }
      })
      .on('pointerenter', function (e, d) { self.focus(d.i); })
      .on('pointerleave', () => this.focus(null))
      .call(drag()
        .on('start', (e, d) => {
          if (!e.active) this.sim.alphaTarget(0.25).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end', (e, d) => {
          if (!e.active) this.sim.alphaTarget(0);
          // Pin where the user put it — dragging a node then watching it drift
          // back is the single most irritating thing a force graph can do.
          this.fixed.set(d.i, { x: e.x, y: e.y });
        }));

    this.sim.on('tick', () => {
      this.edges
        .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      this.nodes.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    this.$crumb.textContent = this.trail.length > 1 ? this.trail.map(shortName).join(' → ') : '';
    this.renderPanel();
    this.$hint.textContent = this.mode === 'people'
      ? 'Lines are correspondence; thicker means more letters. Click to explore, drag to rearrange, scroll to zoom.'
      : 'Subjects appearing together on the same item. Roosevelt is omitted — he connects to everything.';
  }

  /** Hover focus: highlight a node's immediate ties and mute the rest. */
  focus(i) {
    if (!this.nodes) return;
    if (i == null) {
      this.nodes.classed('dim', false);
      this.edges.classed('dim', false).classed('hot', false);
      return;
    }
    const near = new Set([i]);
    this.edges.each((d) => {
      if (d.source.i === i) near.add(d.target.i);
      else if (d.target.i === i) near.add(d.source.i);
    });
    this.nodes.classed('dim', (d) => !near.has(d.i));
    this.edges
      .classed('hot', (d) => d.source.i === i || d.target.i === i)
      .classed('dim', (d) => d.source.i !== i && d.target.i !== i);
  }

  doZoom(kind) {
    const svg = select(this.$svg);
    if (kind === 'fit') { svg.transition().duration(320).call(this.zoomer.transform, zoomIdentity); return; }
    svg.transition().duration(220).call(this.zoomer.scaleBy, kind === 'in' ? 1.45 : 1 / 1.45);
  }

  select(n) {
    if (n === this.selected) { this.openAt(n); return; }
    this.expand(n);
  }

  url(n, param) {
    return `${TRC}?${param || this.g.param}=${encodeURIComponent(this.g.nodes[n][2])}`;
  }

  openAt(n) { window.open(this.url(n), '_blank', 'noopener'); }

  /**
   * A node is a person; the TRC's search is per-role.
   *
   * Someone appears in the archive as a creator and as a recipient, under two
   * different term IDs with different counts, and ?creator= and ?recipient= are
   * separate searches. Showing one combined figure next to a link that applies
   * only one role is a quiet lie — TR's node read "30,656 items" while its link
   * returned 58,180. So the panel states the combined total and then offers each
   * role as its own link, labelled with its own count.
   */
  roleLinks(n) {
    const node = this.g.nodes[n];
    const roles = this.g.roleParams;
    if (!roles || node.length < 7) {
      return [{ label: 'View at the TR Center', href: this.url(n) }];
    }
    const [wrote, received] = [node[5], node[6]];
    const out = [];
    if (wrote) out.push({ label: `Wrote (${wrote.toLocaleString()})`, href: this.url(n, roles.wrote) });
    if (received) out.push({ label: `Received (${received.toLocaleString()})`, href: this.url(n, roles.received) });
    return out.length ? out : [{ label: 'View at the TR Center', href: this.url(n) }];
  }

  renderPanel() {
    const n = this.selected;
    if (n == null) { this.$panel.hidden = true; return; }
    const node = this.g.nodes[n];
    const total = (this.g.adj.get(n) || []).length;
    const shown = [...this.visible].filter((v) => v !== n && (this.g.adj.get(n) || []).some(([o]) => o === v)).length;
    const unit = this.mode === 'people' ? 'connections' : 'related subjects';
    const arrow = '<svg viewBox="0 0 24 24" stroke-linecap="round"><path d="M7 17L17 7M7 7h10v10"/></svg>';
    this.$panel.hidden = false;
    this.$panel.innerHTML = `
      <h3>${this.escape(node[1])}</h3>
      <div class="m">${node[3].toLocaleString()} items · showing ${shown} of ${total} ${unit}</div>
      <div class="acts">
        ${this.roleLinks(n).map((l) =>
          `<a href="${this.escape(l.href)}" target="_blank" rel="noopener">${this.escape(l.label)}${arrow}</a>`).join('')}
        ${shown < total ? '<button data-more>Show more connections</button>' : ''}
      </div>`;
    const more = this.$panel.querySelector('[data-more]');
    if (more) more.addEventListener('click', () => this.expand(n));
    this.dispatchEvent(new CustomEvent('trc-node', {
      bubbles: true,
      detail: { mode: this.mode, name: node[1], slug: node[2], items: node[3], url: this.url(n) },
    }));
  }

  escape(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  announce(msg) { this.$sr.textContent = msg; }
}

TrcGraph._src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
if (!customElements.get('trc-graph')) customElements.define('trc-graph', TrcGraph);
