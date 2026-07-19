/**
 * Name + search-key normalization for TRC taxonomy terms.
 *
 * The TR Center uses Library of Congress name-authority format:
 *
 *   "Lodge, Henry Cabot, 1850-1924"
 *   "Mackay, Clarence H. (Clarence Hungerford), 1874-1938"
 *   "Roosevelt, Theodore, 1858-1919"
 *
 * A user types "henry cabot lodge". Naive substring matching fails completely.
 * This module builds a search key containing every reasonable way a person
 * might type the name, so the widget can match on any of them.
 *
 * No dependencies. Pure functions. Tested in scripts/names.test.mjs.
 */

/**
 * Decode HTML entities in term names.
 *
 * WordPress returns taxonomy names HTML-encoded, so "Underwood & Underwood"
 * arrives as "Underwood &amp; Underwood". Left alone this breaks twice: the
 * widget displays a literal "&amp;", and normalization turns the entity into
 * the word "amp", so the search key reads "underwood amp underwood" and a user
 * typing "underwood & underwood" matches nothing.
 *
 * Observed in 388 terms across the archive, all of them &amp; — but decoding
 * the full common set costs nothing and guards against future imports.
 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', deg: '°', middot: '·',
};

export function decodeEntities(str) {
  return String(str)
    // Numeric: &#39; and &#x27;
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Named
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    // WordPress occasionally double-encodes (&amp;amp;) — one more pass.
    .replace(/&amp;/g, '&');
}

/** Lowercase, strip diacritics, collapse punctuation and whitespace. */
export function normalize(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Strip a trailing life-date range from an authority name.
 *   "Lodge, Henry Cabot, 1850-1924"  -> "Lodge, Henry Cabot"
 *   "Fish, Hamilton, II, 1849-1936"  -> "Fish, Hamilton, II"
 *   "Elks (Fraternal order)"         -> unchanged
 *
 * Handles open ranges ("1858-"), approximate dates ("ca. 1858-1919"),
 * and single years ("b. 1858").
 */
export function stripDates(name) {
  return String(name)
    .replace(/,?\s*\(?(?:ca\.?|approximately|b\.|d\.)?\s*\d{3,4}\??\s*(?:-|–|—)\s*(?:ca\.?\s*)?\d{0,4}\??\)?\s*$/i, '')
    .replace(/,\s*$/, '')
    .trim();
}

/**
 * Remove a parenthetical name expansion.
 *   "Mackay, Clarence H. (Clarence Hungerford)" -> "Mackay, Clarence H."
 * Returns { base, expansion } so we can index both forms.
 */
export function splitExpansion(name) {
  const m = String(name).match(/^(.*?)\s*\(([^)]+)\)\s*(.*)$/);
  if (!m) return { base: String(name).trim(), expansion: null };
  const base = `${m[1]} ${m[3]}`.replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
  return { base, expansion: m[2].trim() };
}

/**
 * Suffixes that should stay attached to the surname rather than being
 * treated as a given name when inverting.
 */
const SUFFIXES = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi',
  'mrs', 'mr', 'ms', 'dr', 'sir', 'lady', 'rev',
]);

/**
 * Invert a "Last, First Middle" authority name into natural order.
 *   "Lodge, Henry Cabot"      -> "Henry Cabot Lodge"
 *   "Fish, Hamilton, II"      -> "Hamilton Fish II"
 *   "Roosevelt, Theodore"     -> "Theodore Roosevelt"
 *   "Elks (Fraternal order)"  -> null  (not a personal name)
 *
 * Returns null when the name has no comma, i.e. it's an organization or a
 * single-token name and inversion would be meaningless.
 */
export function invertName(name) {
  const clean = String(name).trim();
  if (!clean.includes(',')) return null;

  const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const surname = parts[0];
  const rest = parts.slice(1);

  // Pull trailing generational suffixes out so they land after the surname.
  const suffixes = [];
  while (rest.length > 1 && SUFFIXES.has(normalize(rest[rest.length - 1]).replace(/\s/g, ''))) {
    suffixes.unshift(rest.pop());
  }

  const given = rest.join(' ').trim();
  if (!given) return null;

  return [given, surname, ...suffixes].join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the full search key for a term name.
 *
 * Returns a single normalized string containing every searchable variant,
 * separated by " | ". The widget matches a user's typed query against this
 * key, so "henry cabot lodge", "lodge", and "lodge henry" all hit the same
 * term.
 *
 * Multi-person terms ("Bigelow, William Sturgis, 1850-1926; Lodge, George
 * Cabot, 1873-1909") are split on ";" and each person indexed separately.
 */
export function buildSearchKey(name) {
  const variants = new Set();
  const raw = decodeEntities(String(name).trim());

  variants.add(normalize(raw));

  for (const segment of raw.split(';')) {
    const seg = segment.trim();
    if (!seg) continue;

    const { base, expansion } = splitExpansion(seg);

    for (const form of [seg, base, expansion].filter(Boolean)) {
      const dateless = stripDates(form);
      variants.add(normalize(dateless));

      const inverted = invertName(dateless);
      if (inverted) variants.add(normalize(inverted));
    }
  }

  variants.delete('');
  return [...variants].join(' | ');
}

/**
 * Extract a sortable surname-first display form and the life dates, useful
 * for grouping and for showing "1850–1924" as secondary text in the UI.
 */
export function extractDates(name) {
  const m = String(name).match(/(\d{3,4})\s*(?:-|–|—)\s*(\d{0,4})/);
  if (!m) return null;
  return { from: m[1], to: m[2] || null };
}
