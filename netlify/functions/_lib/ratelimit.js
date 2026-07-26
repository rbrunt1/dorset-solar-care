// Brute-force and bot defence for the admin endpoint.
//
// Why this exists: the admin page has no username to guess and no account
// lockout, and the endpoint URL sits in a public repo. Without limits, someone
// could fire unlimited guesses at it as fast as the network allows — which is
// what would make a 12-character password dangerous.
//
// Four layers, weakest first:
//
//  1. A required client header. The admin page sends X-SolarMOT-Client on every
//     request; anything without it is refused before the password is even read.
//     This is NOT real security — the header name is visible in the public JS,
//     so a determined attacker just sends it. What it does do is turn away the
//     overwhelming majority of hostile traffic, which is automated scanners
//     blindly POSTing at every path they can find. Cheap, and it keeps the
//     failure counters clean so a real attempt stands out in the logs.
//
//  2. Per-IP failure limit, now 5 per window.
//
//  3. Escalating lockout. Each additional failure past the limit lengthens the
//     block: 15 minutes, then an hour, then six. A human who mistyped waits a
//     quarter of an hour; a script grinding away gets progressively frozen out.
//
//  4. A global cap across all IPs. Layers 2 and 3 are per-IP, so a botnet with
//     a thousand addresses would sail past them — five guesses each is five
//     thousand guesses. The global cap catches exactly that shape of attack.
//
// Counters live in Netlify Blobs, so they are shared across function instances
// rather than held in per-instance memory (which resets on every cold start and
// would make the limits meaningless).
//
// Only FAILURES count, and a successful sign-in clears the counter, so ordinary
// use is never throttled.
//
// Everything here fails OPEN on a storage error. That is the opposite of the
// auth decision and it is deliberate: the password check runs regardless, so a
// Blobs outage that broke rate limiting must not also lock the owner out of his
// own customer records.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

// Block duration by how far past the limit a client has gone.
const ESCALATION = [
  { over: 0,  ms: 15 * 60 * 1000 },   // 5–9 failures:  15 minutes
  { over: 5,  ms: 60 * 60 * 1000 },   // 10–19:          1 hour
  { over: 15, ms: 6 * 60 * 60 * 1000 } // 20+:            6 hours
];

// Across every IP. Set well above what one flustered human produces, but far
// below what a distributed attack needs to be worth running.
const GLOBAL_MAX_FAILURES = 40;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const CLIENT_HEADER = 'x-solarmot-client';

function clientIp(event) {
  const fwd = event.headers?.['x-nf-client-connection-ip']
           || event.headers?.['x-forwarded-for']
           || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

/**
 * Is this request even from the admin page?
 *
 * Case-insensitive because header casing varies by proxy. Returns true/false
 * only — the caller decides what to do.
 */
function hasClientHeader(event) {
  const h = event.headers || {};
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === CLIENT_HEADER && String(h[key]).trim()) return true;
  }
  return false;
}

function blockDurationMs(failures) {
  const over = failures - MAX_FAILURES;
  let ms = ESCALATION[0].ms;
  for (const step of ESCALATION) if (over >= step.over) ms = step.ms;
  return ms;
}

/** @returns {Promise<{limited: boolean, retryAfterSec?: number, reason?: string}>} */
async function checkRateLimit(openStore, event) {
  try {
    const store = openStore(event, 'admin-throttle');
    const now = Date.now();

    // --- global first: a distributed attack shows up here, not per-IP -----
    const g = await store.get('global', { type: 'json' });
    if (g && now - g.first <= GLOBAL_WINDOW_MS && g.count >= GLOBAL_MAX_FAILURES) {
      return {
        limited: true,
        retryAfterSec: Math.ceil((GLOBAL_WINDOW_MS - (now - g.first)) / 1000),
        reason: 'global'
      };
    }

    // --- then this specific client ----------------------------------------
    const key = `fail-${clientIp(event)}`;
    const rec = await store.get(key, { type: 'json' });
    if (!rec) return { limited: false };

    if (now - rec.first > WINDOW_MS && rec.count < MAX_FAILURES) {
      await store.delete(key);
      return { limited: false };
    }

    if (rec.count >= MAX_FAILURES) {
      const blockMs = blockDurationMs(rec.count);
      const since = now - (rec.last || rec.first);
      if (since < blockMs) {
        return {
          limited: true,
          retryAfterSec: Math.ceil((blockMs - since) / 1000),
          reason: 'ip'
        };
      }
      // Block served. Clear it so an honest owner gets a clean slate.
      await store.delete(key);
      return { limited: false };
    }
    return { limited: false };
  } catch (err) {
    console.warn('[admin] rate limit check unavailable, allowing through:', err.message);
    return { limited: false };
  }
}

async function recordFailure(openStore, event) {
  try {
    const store = openStore(event, 'admin-throttle');
    const now = Date.now();

    const key = `fail-${clientIp(event)}`;
    const rec = await store.get(key, { type: 'json' });
    if (!rec || (now - rec.first > WINDOW_MS && rec.count < MAX_FAILURES)) {
      await store.setJSON(key, { first: now, last: now, count: 1 });
    } else {
      await store.setJSON(key, { first: rec.first, last: now, count: rec.count + 1 });
    }

    const g = await store.get('global', { type: 'json' });
    if (!g || now - g.first > GLOBAL_WINDOW_MS) {
      await store.setJSON('global', { first: now, count: 1 });
    } else {
      await store.setJSON('global', { first: g.first, count: g.count + 1 });
    }
  } catch (err) {
    console.warn('[admin] could not record failed sign-in:', err.message);
  }
}

async function clearFailures(openStore, event) {
  try {
    const store = openStore(event, 'admin-throttle');
    await store.delete(`fail-${clientIp(event)}`);
  } catch { /* nothing useful to do */ }
}

module.exports = {
  checkRateLimit, recordFailure, clearFailures,
  clientIp, hasClientHeader, blockDurationMs,
  MAX_FAILURES, WINDOW_MS, GLOBAL_MAX_FAILURES, GLOBAL_WINDOW_MS, CLIENT_HEADER, ESCALATION
};
