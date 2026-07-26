// Failed-login rate limiting for the admin endpoint.
//
// Why this exists: the admin page has no username to guess and no account
// lockout, and the endpoint URL is public. Without a limit, someone could fire
// unlimited guesses at it as fast as the network allows — which is precisely
// what makes a short password dangerous. With a limit, guessing becomes
// impractical even against a 12-character passphrase.
//
// Counters live in Netlify Blobs, so they are shared across function instances
// rather than held in per-instance memory (which resets constantly on Lambda
// and would make the limit meaningless).
//
// Deliberate design choices:
//  - Only FAILURES count. A successful sign-in clears the counter, so normal
//    use is never throttled.
//  - Keyed by client IP. Not perfect (shared NAT, rotating IPs) but it raises
//    the cost of a naive attack enormously, which is the goal.
//  - Fails OPEN on storage errors. This is the opposite of the auth decision
//    and is deliberate: the password check still runs regardless, so a Blobs
//    outage that broke rate limiting must not also lock the owner out of his
//    own customer records. Losing the limiter degrades defence in depth; making
//    it fatal would create a denial of service.

const MAX_FAILURES = 10;      // per window, per IP
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(event) {
  const fwd = event.headers?.['x-nf-client-connection-ip']
           || event.headers?.['x-forwarded-for']
           || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

/** @returns {Promise<{limited: boolean, retryAfterSec?: number}>} */
async function checkRateLimit(openStore, event) {
  try {
    const store = openStore(event, 'admin-throttle');
    const key = `fail-${clientIp(event)}`;
    const rec = await store.get(key, { type: 'json' });
    if (!rec) return { limited: false };

    const age = Date.now() - rec.first;
    if (age > WINDOW_MS) {
      await store.delete(key);
      return { limited: false };
    }
    if (rec.count >= MAX_FAILURES) {
      return { limited: true, retryAfterSec: Math.ceil((WINDOW_MS - age) / 1000) };
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
    const key = `fail-${clientIp(event)}`;
    const rec = await store.get(key, { type: 'json' });
    const now = Date.now();
    if (!rec || now - rec.first > WINDOW_MS) {
      await store.setJSON(key, { first: now, count: 1 });
    } else {
      await store.setJSON(key, { first: rec.first, count: rec.count + 1 });
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

module.exports = { checkRateLimit, recordFailure, clearFailures, clientIp, MAX_FAILURES, WINDOW_MS };
