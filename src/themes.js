/**
 * Shared brand themes for all three TRC widgets.
 *
 * Every widget styles itself entirely through `--trc-*` custom properties, so a
 * theme is nothing more than a set of token overrides. This string is inlined
 * into each widget's stylesheet at build time, which keeps the palettes in one
 * place rather than copied three ways.
 *
 * Selected by the `theme` attribute on the element:
 *
 *   <trc-search>                          default — Theodore Roosevelt Center
 *   <trc-graph theme="trlibrary">          Theodore Roosevelt Presidential Library
 *   <trc-topic theme="trlibrary-dark">     white-on-green for TRPL's dark sections
 *   <trc-topic theme="inherit">            adopt the host page's fonts
 *   <trc-graph theme="auto">               follow the OS dark-mode preference
 *
 * `trlibrary` restyles to trlibrary.com — coral, deep navy, Clearface headings.
 * `trlibrary-dark` is the same brand in reverse: white text on TRPL's forest
 * green (#1B4633), for dropping a topic list into one of their dark editorial
 * columns (the "From the Archives" block). All values sampled from the live
 * site's computed styles. Like the default theme, no webfonts are fetched —
 * Clearface / Dharma Gothic / Frutiger are declared as stacks and resolve when
 * the host serves them (trlibrary.com does), falling back cleanly elsewhere.
 */
export const THEMES = `
:host([theme=trlibrary]){
  --trc-navy:#25282A;         /* charcoal body text */
  --trc-navy-soft:#5c6b7d;    /* muted slate for secondary text */
  --trc-rust:#E7805D;         /* coral — accent, links, actions */
  --trc-sage:#dfe6ee;         /* pale blue tint for chips and fills */
  --trc-paper:#f4f2ee;        /* warm off-white panels */
  --trc-line:#d8d5cf;
  --trc-white:#ffffff;
  --trc-radius:2px;
  --trc-body:"Frutiger","Helvetica Neue",Arial,system-ui,sans-serif;
  --trc-head:"Clearface","Playfair Display",Georgia,serif;
}
@media(prefers-color-scheme:dark){
  :host([theme="trlibrary auto"]){
    --trc-navy:#ecebe8;--trc-navy-soft:#9aa7b4;--trc-rust:#ef9873;
    --trc-sage:#2b3a49;--trc-paper:#1b1e21;--trc-white:#15181b;--trc-line:#333a41;
  }
}

/* White-on-green, for TRPL's dark editorial columns. The surface IS the green,
   so the widget reads as a seamless panel whether it sits inside their
   #1B4633 section or stands alone. */
:host([theme=trlibrary-dark]){
  --trc-navy:#f4f2ec;                  /* near-white heading + body text */
  --trc-navy-soft:#a9c2b2;             /* muted sage for counts + secondary */
  --trc-rust:#f0a988;                  /* warm light coral, legible on green */
  --trc-sage:rgba(255,255,255,.30);    /* the "view all" divider rule */
  --trc-paper:rgba(255,255,255,.08);   /* row hover lift */
  --trc-line:rgba(255,255,255,.16);    /* hairline dividers */
  --trc-white:#1B4633;                 /* TRPL forest green — the panel itself */
  --trc-radius:2px;
  --trc-body:"Clearface","Playfair Display",Georgia,serif;
  --trc-head:"Dharma Gothic E","Oswald","Arial Narrow",sans-serif;
}
/* Match the neighbouring columns: a tall uppercase display heading, no card
   outline, underlined links. These target <trc-topic>'s classes; on the other
   widgets the selectors simply don't match. */
:host([theme=trlibrary-dark]) .card{border:0}
:host([theme=trlibrary-dark]) h3{
  border-bottom-color:rgba(255,255,255,.22);
  text-transform:uppercase;font-weight:700;letter-spacing:.01em;
  font-size:30px;line-height:1.04;padding-top:2px;
}
:host([theme=trlibrary-dark]) h3 .tot{
  text-transform:none;letter-spacing:0;font-family:var(--trc-body);
}
:host([theme=trlibrary-dark]) a.row .label{text-decoration:underline;text-underline-offset:2px}
:host([theme=trlibrary-dark]) a.row:hover .label{text-decoration:none}`;
