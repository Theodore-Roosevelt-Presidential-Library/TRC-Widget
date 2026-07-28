/**
 * Gentle HTTP client shared by both harvesters.
 *
 * The Theodore Roosevelt Center runs on WP Engine, which returns 502s and 504s
 * when a query outlasts the gateway timeout. Both the taxonomy harvest and the
 * much heavier fingerprint harvest hit that, so the courtesy logic lives here in
 * one place rather than in two copies that drift apart.
 *
 * Two ideas do the work:
 *
 *   1. Patient, jittered retries. A struggling gateway needs seconds — sometimes
 *      a full minute while it restarts — not another request half a second
 *      later. Backoff caps at a minute and a server's own Retry-After always
 *      wins.
 *
 *   2. Adaptive pacing. Every retry slows the steady delay between *all*
 *      requests; a stretch of clean responses eases it back down. So one rough
 *      patch on their end quiets the whole harvest, which is the difference
 *      between backing off and merely retrying.
 *
 * No dependencies. Node 18+ (global fetch).
 */

export const USER_AGENT =
  'TRC-Widget-Harvester/1.0 (+https://github.com/mbriney/TRC-Widget) - caching public taxonomy data for an embeddable search widget';

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const MAX_RETRIES = 8;
const BASE_BACKOFF_MS = 2000;   // 2s, 4s, 8s, 16s, 32s, then capped
const MAX_BACKOFF_MS = 60000;   // a full minute for a gateway to come back

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared adaptive pace between successful requests. */
let pace = MIN_DELAY_MS;
export const currentPace = () => pace;
export const slower = () => { pace = Math.min(MAX_DELAY_MS, Math.round(pace * 1.6)); };
export const easier = () => { pace = Math.max(MIN_DELAY_MS, Math.round(pace * 0.9)); };

/** Backoff for retry N, capped, with ±30% jitter so retries never synchronise. */
function backoff(attempt) {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

/**
 * Fetch a URL, retrying transient server errors with adaptive backoff.
 *
 * `onRetry(msg)` is an optional logger. Throws only after the retry budget is
 * spent, or immediately on a non-retryable status (e.g. 400 past-end-of-results,
 * which the caller handles).
 */
export async function fetchGentle(url, { onRetry, waitFn = sleep, attempt = 0 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.ok) return res;

    const retryable = res.status >= 500 || res.status === 429;
    if (retryable && attempt < MAX_RETRIES) {
      slower();
      const hinted = Number(res.headers.get('retry-after')) * 1000;
      const wait = Number.isFinite(hinted) && hinted > 0 ? hinted : backoff(attempt);
      onRetry?.(`${res.status} on ${new URL(url).search} — retry ${attempt + 1}/${MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s (pace now ${pace}ms)`);
      await waitFn(wait);
      return fetchGentle(url, { onRetry, waitFn, attempt: attempt + 1 });
    }
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  } catch (err) {
    if (attempt < MAX_RETRIES && !err.message.startsWith('HTTP ')) {
      slower();
      const wait = backoff(attempt);
      onRetry?.(`${err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s (pace now ${pace}ms)`);
      await waitFn(wait);
      return fetchGentle(url, { onRetry, waitFn, attempt: attempt + 1 });
    }
    throw err;
  }
}

/** Note a clean request; eases the pace back down after a sustained run. */
let clean = 0;
export function ok(runLength = 5) {
  if (++clean >= runLength) { easier(); clean = 0; }
}
