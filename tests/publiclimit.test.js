/**
 * Public-endpoint abuse limits.
 *
 * The headline case is the mailbomb: the customer acknowledgement is sent to
 * whatever address was typed into the form, unverified. Without a per-address
 * cap, anyone could loop against the enquiry endpoint with a victim's address
 * and have this domain send them thousands of genuine, signed emails.
 *
 * The second rule matters just as much in the other direction: hitting that cap
 * must NOT reject the submission. A real person filling in the form twice still
 * needs their enquiry to reach the business.
 */
const assert = require('node:assert');
const {
  checkSubmissionLimit, mayAcknowledge, clientIp, emailKey,
  IP_MAX_SUBMISSIONS, EMAIL_MAX_ACKS, EMAIL_WINDOW_MS, IP_WINDOW_MS
} = require('../netlify/functions/_lib/publiclimit.js');

let passed = 0, failed = 0;
const real = console.log;
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { real(`  PASS  ${name}`); passed++; })
  .catch(e => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });

function makeStore() {
  const map = new Map();
  const open = () => ({
    async get(k) { return map.get(k) || null; },
    async setJSON(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); }
  });
  return { open, map };
}
const broken = () => { throw new Error('simulated Blobs outage'); };
const ev = (ip = '203.0.113.5') => ({ headers: { 'x-nf-client-connection-ip': ip } });

(async () => {
  // ---- the mailbomb ----------------------------------------------------
  await test('a victim address is capped after a few acknowledgements', async () => {
    const s = makeStore();
    const victim = 'victim@example.test';
    for (let i = 0; i < EMAIL_MAX_ACKS; i++) {
      const r = await mayAcknowledge(s.open, ev(), victim);
      assert.strictEqual(r.allowed, true, `attempt ${i + 1} should be allowed`);
    }
    const blocked = await mayAcknowledge(s.open, ev(), victim);
    assert.strictEqual(blocked.allowed, false, 'the mailbomb must stop here');
  });

  await test('changing IP does not get round the address cap', async () => {
    const s = makeStore();
    const victim = 'victim@example.test';
    for (let i = 0; i < EMAIL_MAX_ACKS; i++) {
      await mayAcknowledge(s.open, ev(`10.0.0.${i}`), victim);
    }
    const r = await mayAcknowledge(s.open, ev('198.51.100.7'), victim);
    assert.strictEqual(r.allowed, false,
      'the cap is per RECIPIENT, so a botnet cannot bypass it');
  });

  await test('case and spacing tricks do not create a fresh quota', async () => {
    assert.strictEqual(emailKey('Victim@Example.test'), emailKey('  victim@example.test  '));
  });

  await test('one victim being capped does not affect a different customer', async () => {
    const s = makeStore();
    for (let i = 0; i < EMAIL_MAX_ACKS + 2; i++) {
      await mayAcknowledge(s.open, ev(), 'victim@example.test');
    }
    const other = await mayAcknowledge(s.open, ev(), 'real.customer@example.test');
    assert.strictEqual(other.allowed, true);
  });

  await test('the quota expires, so a returning customer is acknowledged again', async () => {
    const s = makeStore();
    const addr = 'customer@example.test';
    for (let i = 0; i < EMAIL_MAX_ACKS; i++) await mayAcknowledge(s.open, ev(), addr);
    assert.strictEqual((await mayAcknowledge(s.open, ev(), addr)).allowed, false);

    const rec = s.map.get(emailKey(addr));
    s.map.set(emailKey(addr), { ...rec, first: Date.now() - EMAIL_WINDOW_MS - 1000 });
    assert.strictEqual((await mayAcknowledge(s.open, ev(), addr)).allowed, true);
  });

  // ---- flooding --------------------------------------------------------
  await test('ordinary use is never throttled', async () => {
    const s = makeStore();
    for (let i = 0; i < 5; i++) {
      const r = await checkSubmissionLimit(s.open, ev());
      assert.strictEqual(r.limited, false, 'a handful of submissions is normal');
    }
  });

  await test('sustained flooding from one address is stopped', async () => {
    const s = makeStore();
    for (let i = 0; i < IP_MAX_SUBMISSIONS; i++) await checkSubmissionLimit(s.open, ev());
    const r = await checkSubmissionLimit(s.open, ev());
    assert.strictEqual(r.limited, true);
    assert.ok(r.retryAfterSec > 0, 'and it says how long to wait');
  });

  await test('one flooding IP does not block everybody else', async () => {
    const s = makeStore();
    for (let i = 0; i < IP_MAX_SUBMISSIONS + 5; i++) await checkSubmissionLimit(s.open, ev('1.1.1.1'));
    assert.strictEqual((await checkSubmissionLimit(s.open, ev('2.2.2.2'))).limited, false);
  });

  await test('the IP limit is generous — at least 20 an hour', () => {
    assert.ok(IP_MAX_SUBMISSIONS >= 20);
    assert.ok(IP_WINDOW_MS <= 60 * 60 * 1000);
  });

  // ---- failure behaviour ----------------------------------------------
  await test('a storage outage lets submissions THROUGH, not away', async () => {
    assert.strictEqual((await checkSubmissionLimit(broken, ev())).limited, false,
      'losing a real enquiry costs more than allowing abuse during an outage');
  });

  await test('a storage outage still allows acknowledgements', async () => {
    assert.strictEqual((await mayAcknowledge(broken, ev(), 'a@b.test')).allowed, true);
  });

  await test('reads the client IP, and copes when there is none', () => {
    assert.strictEqual(clientIp(ev('9.9.9.9')), '9.9.9.9');
    assert.strictEqual(clientIp({ headers: {} }), 'unknown');
  });

  real(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
