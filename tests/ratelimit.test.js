/**
 * Brute-force and bot defence tests.
 *
 * These are what make a 12-character password defensible on an endpoint with no
 * username and no lockout, so the behaviour is pinned down properly: failures
 * count, successes clear, blocks escalate, a distributed attack is caught by the
 * global cap, and a storage outage must never lock the owner out of his own data.
 */
const assert = require('node:assert');
const {
  checkRateLimit, recordFailure, clearFailures,
  clientIp, hasClientHeader, blockDurationMs,
  MAX_FAILURES, WINDOW_MS, GLOBAL_MAX_FAILURES, CLIENT_HEADER
} = require('../netlify/functions/_lib/ratelimit.js');

let passed = 0, failed = 0;
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { console.log(`  PASS  ${name}`); passed++; })
  .catch(e => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });

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
  // --- the bot filter ---------------------------------------------------
  await test('accepts a request carrying the client header', () =>
    assert.strictEqual(hasClientHeader({ headers: { 'X-SolarMOT-Client': 'admin' } }), true));

  await test('header check is case-insensitive (proxies rewrite casing)', () =>
    assert.strictEqual(hasClientHeader({ headers: { [CLIENT_HEADER]: 'admin' } }), true));

  await test('rejects a request with no client header — the scanner case', () =>
    assert.strictEqual(hasClientHeader({ headers: {} }), false));

  await test('rejects an empty client header', () =>
    assert.strictEqual(hasClientHeader({ headers: { 'x-solarmot-client': '   ' } }), false));

  // --- per-IP limit -----------------------------------------------------
  await test('the limit is 5', () => assert.strictEqual(MAX_FAILURES, 5));

  await test('extracts the client IP', () =>
    assert.strictEqual(clientIp(ev('9.9.9.9')), '9.9.9.9'));

  await test('a fresh client is not limited', async () => {
    const s = makeStore();
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test('is not limited at 4 failures', async () => {
    const s = makeStore();
    for (let i = 0; i < 4; i++) await recordFailure(s.open, ev());
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test('is limited at 5 failures', async () => {
    const s = makeStore();
    for (let i = 0; i < 5; i++) await recordFailure(s.open, ev());
    const r = await checkRateLimit(s.open, ev());
    assert.strictEqual(r.limited, true);
    assert.strictEqual(r.reason, 'ip');
    assert.ok(r.retryAfterSec > 0, 'should say how long to wait');
  });

  await test('a success clears the count, so normal use is never throttled', async () => {
    const s = makeStore();
    for (let i = 0; i < 5; i++) await recordFailure(s.open, ev());
    await clearFailures(s.open, ev());
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  await test('one IP being blocked does not block another', async () => {
    const s = makeStore();
    for (let i = 0; i < 5; i++) await recordFailure(s.open, ev('5.5.5.5'));
    assert.strictEqual((await checkRateLimit(s.open, ev('5.5.5.5'))).limited, true);
    assert.strictEqual((await checkRateLimit(s.open, ev('6.6.6.6'))).limited, false);
  });

  // --- escalation -------------------------------------------------------
  await test('blocks get longer the more a client fails', () => {
    const first = blockDurationMs(5);
    const second = blockDurationMs(10);
    const third = blockDurationMs(25);
    assert.ok(second > first, 'second tier should exceed the first');
    assert.ok(third > second, 'third tier should exceed the second');
  });

  await test('the first block is 15 minutes', () =>
    assert.strictEqual(blockDurationMs(5), 15 * 60 * 1000));

  await test('a served block expires and gives a clean slate', async () => {
    const s = makeStore();
    for (let i = 0; i < 5; i++) await recordFailure(s.open, ev());
    const rec = s.map.get('fail-1.2.3.4');
    // Pretend the last failure was longer ago than the block duration.
    s.map.set('fail-1.2.3.4', { ...rec, last: Date.now() - blockDurationMs(5) - 1000 });
    assert.strictEqual((await checkRateLimit(s.open, ev())).limited, false);
  });

  // --- global cap: the distributed attack -------------------------------
  await test('a botnet using a fresh IP per guess is still stopped', async () => {
    const s = makeStore();
    // One failure each from many different addresses — never trips the per-IP
    // limit, which is exactly the attack the global cap exists for.
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
      await recordFailure(s.open, ev(`10.0.0.${i}`));
    }
    const r = await checkRateLimit(s.open, ev('10.0.99.99'));
    assert.strictEqual(r.limited, true);
    assert.strictEqual(r.reason, 'global');
  });

  await test('the global cap is not tripped by ordinary numbers of failures', async () => {
    const s = makeStore();
    for (let i = 0; i < 3; i++) await recordFailure(s.open, ev(`10.0.1.${i}`));
    assert.strictEqual((await checkRateLimit(s.open, ev('10.0.2.1'))).limited, false);
  });

  // --- outage behaviour -------------------------------------------------
  await test('fails OPEN on a storage outage, so the owner is never locked out', async () => {
    assert.strictEqual((await checkRateLimit(broken, ev())).limited, false);
  });

  await test('recording a failure during an outage does not throw', async () => {
    await recordFailure(broken, ev());
  });

  await test('clearing failures during an outage does not throw', async () => {
    await clearFailures(broken, ev());
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
