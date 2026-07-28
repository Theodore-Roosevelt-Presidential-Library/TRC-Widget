/**
 * Tests for the gentle HTTP client.
 *
 * The retry and pacing behaviour is what keeps the harvester from hammering a
 * struggling server, so it's worth pinning. `fetch` is stubbed — no network.
 *
 * Run: node --test scripts/http.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGentle, currentPace, slower, easier, ok } from './http.mjs';

const realFetch = globalThis.fetch;
const res = (status, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => ({}),
});

// Records requested waits instead of actually sleeping, so the retry tests run
// instantly while still asserting on the timing the client *chose*.
function recordingWaiter() {
  const waits = [];
  return { waits, waitFn: async (ms) => { waits.push(ms); } };
}

beforeEach(() => {
  // Reset pace to the floor before each test by easing repeatedly.
  for (let i = 0; i < 40; i++) easier();
});

test('returns immediately on a 200', async () => {
  globalThis.fetch = async () => res(200);
  const r = await fetchGentle('https://x.test/ok');
  assert.equal(r.status, 200);
  globalThis.fetch = realFetch;
});

test('retries 5xx then succeeds, and does not throw', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n < 3 ? res(504) : res(200));
  const { waits, waitFn } = recordingWaiter();
  const r = await fetchGentle('https://x.test/flaky', { onRetry: () => {}, waitFn });
  assert.equal(r.status, 200);
  assert.equal(n, 3, 'should have taken three attempts');
  assert.equal(waits.length, 2, 'two failures means two waits');
  assert.ok(waits[1] > waits[0], 'backoff should grow between retries');
  globalThis.fetch = realFetch;
});

test('a retry raises the shared pace; sustained success lowers it', async () => {
  const floor = currentPace();
  globalThis.fetch = async () => res(503);
  const { waitFn } = recordingWaiter();
  await assert.rejects(fetchGentle('https://x.test/down', { onRetry: () => {}, waitFn }));
  assert.ok(currentPace() > floor, 'pace should climb after failures');

  const high = currentPace();
  for (let i = 0; i < 30; i++) ok(5);
  assert.ok(currentPace() < high, 'pace should recover after clean requests');
  globalThis.fetch = realFetch;
});

test('honours a Retry-After header over the computed backoff', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n < 2 ? res(429, { 'retry-after': '1' }) : res(200));
  const { waits, waitFn } = recordingWaiter();
  await fetchGentle('https://x.test/throttled', { onRetry: () => {}, waitFn });
  assert.equal(waits.length, 1);
  assert.equal(waits[0], 1000, `Retry-After: 1 should force a 1000ms wait, got ${waits[0]}`);
  globalThis.fetch = realFetch;
});

test('a 400 is not retried — it is the caller\'s end-of-data signal', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return res(400); };
  await assert.rejects(fetchGentle('https://x.test/past-end'), /HTTP 400/);
  assert.equal(n, 1, '400 must fail on the first try, not retry');
  globalThis.fetch = realFetch;
});

test('pace never runs away or drops below the floor', () => {
  for (let i = 0; i < 100; i++) slower();
  assert.ok(currentPace() <= 8000, 'pace is capped');
  for (let i = 0; i < 100; i++) easier();
  assert.ok(currentPace() >= 500, 'pace has a floor');
});
