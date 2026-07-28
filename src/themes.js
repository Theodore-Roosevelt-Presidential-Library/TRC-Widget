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
 *   <trc-topic theme="inherit">            adopt the host page's fonts
 *   <trc-graph theme="auto">               follow the OS dark-mode preference
 *
 * `trlibrary` restyles to trlibrary.com — coral, deep navy, Clearface headings.
 * Values sampled from the live site. Like the default theme, no webfonts are
 * fetched: Clearface and Frutiger are declared as a stack and picked up when the
 * host already serves them (which trlibrary.com does), falling back cleanly
 * elsewhere.
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
}`;
