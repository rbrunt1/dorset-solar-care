/**
 * Rate limit tests.
 *
 * This is what makes a 12-character password defensible on an endpoint with no
 * username and no lockout, so the behaviour is pinned down: failures count,
 * successes clear, the window expires, and a storage outage must not lock the
 * owner out of his own data.
 */
const assert = require('node:assert');
const {
  checkRateLimit, recordFailure, clearFailures, clientIp, MAX_FAILURES, WINDOW_MS
} = require('../netlify/functions/_lib/ratelimit.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  PASS  ${name}`); passed++; })
    .catch(e => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });
}

// In-memory stand-in for Netlify Blobs.
function makeStore() {
  const map = new Map();
  const store = {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async setJSON(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); }
  };
  return { open: () => store, map };
}
const broken = () => { throw new Error('simulated Blobs outage'); };

const ev = (ip = '1.2.3.4') => ({ headers: { 'x-nf-client-connection-ip': ip } });

(async () => {
  await test('extracts the client IP', () =>
    assert.strictEqual(clientIp(ev('9.9.9.9')), '9.9.9.9'));

  await test('falls back to "unknown" with no IP header', () =>
    assert.strictEqual(clientIp({ headers: {} }), 'unknown'));

  await test('a fresh client is not limited', async () => {
    const s = makeStore();
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test(`is not limited at ${MAX_FAILURES - 1} failures`, async () => {
    const s = makeStore();
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordFailure(s.open, ev());
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test(`is limited at ${MAX_FAILURES} failures`, async () => {
    const s = makeStore();
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailure(s.open, ev());
    const r = await checkRateLimit(s.open, ev());
    assert.strictEqual(r.limited, true);
    assert.ok(r.retryAfterSec > 0, 'should report how long to wait');
  });

  await test('a success clears the count, so normal use is never throttled', async () => {
    const s = makeStore();
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailure(s.open, ev());
    await clearFailures(s.open, ev());
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test('one IP being blocked does not block another', async () => {
    const s = makeStore();
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailure(s.open, ev('5.5.5.5'));
    assert.strictEqual((await checkRateLimit(s.open, ev('5.5.5.5'))).limited, true);
    assert.strictEqual((await checkRateLimit(s.open, ev('6.6.6.6'))).limited, false);
  });

  await test('the window expires', async () => {
    const s = makeStore();
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailure(s.open, ev());
    // Age the record past the window.
    const rec = s.map.get('fail-1.2.3.4');
    s.map.set('fail-1.2.3.4', { ...rec, first: Date.now() - WINDOW_MS - 1000 });
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test('fails OPEN on a storage outage, so the owner is never locked out', async () => {
    assert.strictEqual((await checkRateLimit(broken, ev())).limited, false);
  });

  await test('recording a failure during an outage does not throw', async () => {
    await recordFailure(broken, ev()); // must not reject
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
