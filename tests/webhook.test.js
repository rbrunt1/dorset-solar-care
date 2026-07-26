/**
 * GoCardless webhook tests.
 *
 * The signature check is the security boundary for the whole payment flow:
 * if it can be bypassed, anyone who discovers the URL can POST "mandate
 * active" and get a free subscription. So it is tested harder than anything
 * else here — valid, tampered, wrong-secret, missing, and empty.
 */
const crypto = require('node:crypto');
const assert = require('node:assert');
const Module = require('node:module');

// Stub @netlify/blobs so this runs with no Netlify account and no network,
// the same way tests/functions.test.js does.
const stubStore = new Map();
const blobsStub = {
  connectLambda() {},
  getStore() {
    return {
      async list() { return { blobs: [...stubStore.keys()].map(key => ({ key })) }; },
      async get(key) { return stubStore.get(key) || null; },
      async setJSON(key, value) { stubStore.set(key, value); }
    };
  }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, request, ...rest);
};
require.cache['@netlify/blobs'] = {
  id: '@netlify/blobs', filename: '@netlify/blobs', loaded: true, exports: blobsStub
};

const SECRET = 'test-webhook-secret-value';
process.env.GOCARDLESS_WEBHOOK_SECRET = SECRET;

const wh = require('../netlify/functions/gocardless-webhook.js');
const { verifySignature, PLAN_PRICING } = wh;

const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const body = JSON.stringify({ events: [{ id: 'EV1', resource_type: 'mandates', action: 'active' }] });

test('accepts a correctly signed body', () =>
  assert.strictEqual(verifySignature(body, sign(body), SECRET), true));

test('rejects a tampered body with a stale signature', () => {
  const good = sign(body);
  const tampered = body.replace('EV1', 'EV2');
  assert.strictEqual(verifySignature(tampered, good, SECRET), false);
});

test('rejects a signature made with a different secret', () =>
  assert.strictEqual(verifySignature(body, sign(body, 'attacker-secret'), SECRET), false));

test('rejects a missing signature header', () =>
  assert.strictEqual(verifySignature(body, undefined, SECRET), false));

test('rejects when no secret is configured (fails closed)', () =>
  assert.strictEqual(verifySignature(body, sign(body), ''), false));

test('rejects a truncated signature without throwing', () =>
  assert.strictEqual(verifySignature(body, sign(body).slice(0, 20), SECRET), false));

test('an empty body still verifies against its own signature', () =>
  assert.strictEqual(verifySignature('', sign(''), SECRET), true));

// --- pricing ------------------------------------------------------------
// These are pence and they are what the customer actually gets charged.
// A wrong number here is a wrong number on a real bank account.
test('plan prices match the published pricing page', () => {
  assert.strictEqual(PLAN_PRICING.essential.amount, 1999);
  assert.strictEqual(PLAN_PRICING.standard.amount, 2999);
  assert.strictEqual(PLAN_PRICING.premium.amount, 3999);
});

test('every plan has a customer-visible name', () => {
  for (const [k, v] of Object.entries(PLAN_PRICING)) {
    assert.ok(v.name && v.name.includes('SolarMOT'), `${k} missing a name`);
  }
});

// --- handler behaviour ---------------------------------------------------
(async () => {
  const call = (h) => wh.handler({ httpMethod: 'POST', body, headers: h });

  const bad = await call({ 'webhook-signature': 'nope' });
  test('handler returns 401 for a bad signature', () =>
    assert.strictEqual(bad.statusCode, 401));

  const none = await call({});
  test('handler returns 401 when the signature header is absent', () =>
    assert.strictEqual(none.statusCode, 401));

  const wrongMethod = await wh.handler({ httpMethod: 'GET', headers: {} });
  test('handler rejects non-POST', () =>
    assert.strictEqual(wrongMethod.statusCode, 405));

  // Unset secret must fail closed, not fall open.
  const saved = process.env.GOCARDLESS_WEBHOOK_SECRET;
  delete process.env.GOCARDLESS_WEBHOOK_SECRET;
  const unconfigured = await call({ 'webhook-signature': sign(body) });
  test('handler returns 503 when the secret is not configured', () =>
    assert.strictEqual(unconfigured.statusCode, 503));
  process.env.GOCARDLESS_WEBHOOK_SECRET = saved;

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
