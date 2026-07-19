/**
 * Tests for name normalization.
 *
 * Every fixture below is a real term name observed in the TRC API, not an
 * invented example. Run with: node --test scripts/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  stripDates,
  splitExpansion,
  invertName,
  buildSearchKey,
  extractDates,
  decodeEntities,
} from './names.mjs';

test('decodeEntities unescapes WordPress-encoded names', () => {
  assert.equal(decodeEntities('Underwood &amp; Underwood'), 'Underwood & Underwood');
  assert.equal(decodeEntities('Whitehead &amp; Hoag Co.'), 'Whitehead & Hoag Co.');
  assert.equal(decodeEntities('Raphael Tuck &amp; Sons'), 'Raphael Tuck & Sons');
  // Numeric and hex forms
  assert.equal(decodeEntities('Roosevelt&#39;s'), "Roosevelt's");
  assert.equal(decodeEntities('Roosevelt&#x27;s'), "Roosevelt's");
  // Double-encoding
  assert.equal(decodeEntities('A &amp;amp; B'), 'A & B');
  // Unknown entities pass through untouched rather than being mangled
  assert.equal(decodeEntities('Smith &fake; Jones'), 'Smith &fake; Jones');
  // Plain text is unaffected
  assert.equal(decodeEntities('Roosevelt, Theodore, 1858-1919'), 'Roosevelt, Theodore, 1858-1919');
});

test('entity-encoded names produce clean search keys', () => {
  const key = buildSearchKey('Underwood &amp; Underwood');
  // The bug this fixes: "amp" leaking into the search key as a word.
  assert.ok(!key.includes('amp'), `stray entity text in key: "${key}"`);
  assert.ok(key.includes('underwood underwood'),
            'a user typing "underwood & underwood" must match');
});

test('normalize strips case, accents and punctuation', () => {
  assert.equal(normalize('Lodge, Henry Cabot, 1850-1924'), 'lodge henry cabot 1850 1924');
  assert.equal(normalize('Muñoz Rivera, Luis'), 'munoz rivera luis');
  assert.equal(normalize('F. & A. M.'), 'f a m');
});

test('stripDates removes life dates but preserves org names', () => {
  assert.equal(stripDates('Lodge, Henry Cabot, 1850-1924'), 'Lodge, Henry Cabot');
  assert.equal(stripDates('Roosevelt, Theodore, 1858-1919'), 'Roosevelt, Theodore');
  assert.equal(stripDates('Hulbert, William Davenport, 1868-1913'), 'Hulbert, William Davenport');
  // Open-ended and organizational names must survive untouched.
  assert.equal(stripDates('Elks (Fraternal order) Phoenix Lodge. No. 335'),
               'Elks (Fraternal order) Phoenix Lodge. No. 335');
  assert.equal(stripDates('Federal Lodge, No. 1'), 'Federal Lodge, No. 1');
});

test('splitExpansion separates parenthetical name expansions', () => {
  const r = splitExpansion('Mackay, Clarence H. (Clarence Hungerford)');
  assert.equal(r.base, 'Mackay, Clarence H.');
  assert.equal(r.expansion, 'Clarence Hungerford');

  const none = splitExpansion('Roosevelt, Theodore');
  assert.equal(none.base, 'Roosevelt, Theodore');
  assert.equal(none.expansion, null);
});

test('invertName produces natural word order', () => {
  assert.equal(invertName('Lodge, Henry Cabot'), 'Henry Cabot Lodge');
  assert.equal(invertName('Roosevelt, Theodore'), 'Theodore Roosevelt');
  assert.equal(invertName('Slosson, Annie Trumbull'), 'Annie Trumbull Slosson');
});

test('invertName keeps generational suffixes after the surname', () => {
  assert.equal(invertName('Fish, Hamilton, II'), 'Hamilton Fish II');
  assert.equal(invertName('Roosevelt, Theodore, Jr.'), 'Theodore Roosevelt Jr.');
});

test('invertName declines to invert organizations', () => {
  assert.equal(invertName('Elks (Fraternal order) Phoenix Lodge. No. 335'), null);
  assert.equal(invertName('Smithsonian'), null);
});

test('buildSearchKey matches the way people actually type names', () => {
  const key = buildSearchKey('Lodge, Henry Cabot, 1850-1924');

  // The whole point of this module: natural word order must be searchable.
  assert.ok(key.includes('henry cabot lodge'), 'should contain inverted form');
  // Authority order must still work for librarians and citation-pasters.
  assert.ok(key.includes('lodge henry cabot'), 'should contain authority form');
  // Dates retained so "lodge 1850" finds him.
  assert.ok(key.includes('1850'), 'should retain life dates');
});

test('buildSearchKey indexes parenthetical expansions', () => {
  const key = buildSearchKey('Mackay, Clarence H. (Clarence Hungerford), 1874-1938');
  assert.ok(key.includes('clarence hungerford'), 'should index the expanded given name');
  assert.ok(key.includes('clarence h mackay') || key.includes('mackay clarence h'),
            'should index the abbreviated form');
});

test('buildSearchKey handles multi-person terms', () => {
  const key = buildSearchKey(
    'Bigelow, William Sturgis, 1850-1926; Lodge, George Cabot, 1873-1909',
  );
  assert.ok(key.includes('william sturgis bigelow'), 'should index first person');
  assert.ok(key.includes('george cabot lodge'), 'should index second person');
});

test('buildSearchKey leaves organization names searchable as written', () => {
  const key = buildSearchKey('Freemasons Matinecock Lodge No. 806, F. & A. M.');
  assert.ok(key.includes('freemasons matinecock lodge'));
});

test('buildSearchKey never returns empty for a non-empty name', () => {
  for (const n of ['Smithsonian', 'Lodge, A C M', 'America', 'e-mail', 'Spoon, Demitasse']) {
    assert.ok(buildSearchKey(n).length > 0, `empty key for "${n}"`);
  }
});

test('extractDates pulls life dates for display', () => {
  assert.deepEqual(extractDates('Lodge, Henry Cabot, 1850-1924'), { from: '1850', to: '1924' });
  assert.deepEqual(extractDates('Smithsonian'), null);
});

/**
 * Regression guard for the bug this module exists to prevent.
 *
 * Before search keys, a user typing "henry cabot lodge" into the Creator field
 * matched nothing at all, while typing "lodge" matched "Blodgett" — the naive
 * substring behavior of the live site today.
 */
test('the motivating failure case is fixed', () => {
  const lodge = buildSearchKey('Lodge, Henry Cabot, 1850-1924');
  const blodgett = buildSearchKey('Blodgett, William T. (William Tilden), 1856-1917');

  assert.ok(lodge.includes('henry cabot lodge'),
            'the query users actually type must match');
  assert.ok(!blodgett.includes('henry cabot lodge'),
            'and must not leak into unrelated surnames');
});
