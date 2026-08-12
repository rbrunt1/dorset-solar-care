/**
 * Handler-level tests for the deposit endpoints.
 *
 * The property being defended is simple: a reservation may only be marked paid
 * by a genuine, recent, correctly-signed Stripe webhook. Not by the browser,
 * not by anyone who guesses the URL, not by a replayed old event.
 *
 * @netlify/blobs and fetch are stubbed so this runs with no account and no
 * network.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const Module = require('node:module');

// ---- stub the blob store -------------------------------------------------
const store = new Map();
const writes = [];
let failOnRead = false;

const stub = {
  connectLambda() {},
  getStore(name) {
    return {
      async get(key) {
        if (failOnRead) throw new Error('simulated blobs outage');
        return store.has(key) ? store.get(key) : null;
      },
      async setJSON(key, value) { store.set(key, value); writes.push({ store: name, key, value }); },
      async list() { return { blobs: [] }; }
    };
  }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, request, ...rest);
};
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', filename: '@netlify/blobs', loaded: true, exports: stub };

// ---- stub Stripe ---------------------------------------------------------
const stripeCalls = [];
let stripeMode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.stripe.com')) {
    stripeCalls.push({ url: String(url), headers: opts.headers || {}, body: String(opts.body || '') });
    if (stripeMode === 'error') {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'no such price' } }) };
    }
    return { ok: true, status: 200, json: async () => ({
      id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123', amount_total: 2500
    }) };
  }
  return realFetch ? realFetch(url, opts) : Promise.reject(new Error('unexpected fetch'));
};

const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');
const checkout = require(path.join(FN_DIR, 'create-deposit-checkout.js'));
const webhook = require(path.join(FN_DIR, 'stripe-webhook.js'));

const SECRET = 'whsec_handler_test';
const nowSec = () => Math.floor(Date.now() / 1000);
const signed = (payload, ts = nowSec(), secret = SECRET) => {
  const body = JSON.stringify(payload);
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return { body, headers: { 'stripe-signature': `t=${ts},v1=${v1}` } };
};
// Netlify puts Blobs credentials on event.blobs for request-triggered
// functions; openStore() refuses without it, so the fake event carries one.
const post = (body, headers = {}) => ({ httpMethod: 'POST', body, headers, blobs: 'stub-credentials' });

const RESERVATION = {
  id: 'reservation-1770000000000-abc123',
  name: 'Test Person', email: 'test@example.com',
  postcode: 'BH12 1AA', depositStatus: 'pending'
};

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function reset() {
  store.clear(); writes.length = 0; stripeCalls.length = 0;
  failOnRead = false; stripeMode = 'ok';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  store.set(RESERVATION.id, { ...RESERVATION });
}

// ================= create-deposit-checkout ================================
test('creates a checkout session for a real reservation', async () => {
  const res = await checkout.handler(post(JSON.stringify({ reservationId: RESERVATION.id })));
  assert.strictEqual(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).url.startsWith('https://checkout.stripe.com/'));
});

test('THE AMOUNT COMES FROM THE SERVER — a price in the request is ignored', async () => {
  await checkout.handler(post(JSON.stringify({
    reservationId: RESERVATION.id, amount: 1, amount_total: 1, unit_amount: 1, price: 1
  })));
  const sent = decodeURIComponent(stripeCalls[0].body);
  assert.ok(sent.includes('unit_amount]=2500'), `expected 2500 in: ${sent}`);
  assert.ok(!/unit_amount\]=1(&|$)/.test(sent), 'a browser-supplied price must never reach Stripe');
});

test('sends the idempotency key so a double submit cannot double charge', async () => {
  await checkout.handler(post(JSON.stringify({ reservationId: RESERVATION.id })));
  const key = stripeCalls[0].headers['Idempotency-Key'] || stripeCalls[0].headers['idempotency-key'];
  assert.strictEqual(key, `deposit-${RESERVATION.id}`);
});

test('rejects malformed reservation ids without touching Stripe', async () => {
  for (const bad of ['', '../../secrets', 'reservation-x-y', 'customer-1-a', '*', 'reservation-1']) {
    const res = await checkout.handler(post(JSON.stringify({ reservationId: bad })));
    assert.strictEqual(res.statusCode, 400, `id "${bad}" should be refused`);
  }
  assert.strictEqual(stripeCalls.length, 0);
});

test('404s a well-formed id that does not exist', async () => {
  const res = await checkout.handler(post(JSON.stringify({ reservationId: 'reservation-1770000000001-zzz999' })));
  assert.strictEqual(res.statusCode, 404);
});

test('will not take a second deposit for an already-paid reservation', async () => {
  store.set(RESERVATION.id, { ...RESERVATION, depositStatus: 'paid' });
  const res = await checkout.handler(post(JSON.stringify({ reservationId: RESERVATION.id })));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).alreadyPaid, true);
  assert.strictEqual(stripeCalls.length, 0, 'no session should be created');
});

test('503s rather than pretending, when Stripe is not configured', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const res = await checkout.handler(post(JSON.stringify({ reservationId: RESERVATION.id })));
  assert.strictEqual(res.statusCode, 503);
});

test('creating checkout NEVER marks the deposit paid', async () => {
  await checkout.handler(post(JSON.stringify({ reservationId: RESERVATION.id })));
  assert.notStrictEqual(store.get(RESERVATION.id).depositStatus, 'paid');
});

test('a Stripe failure says the reservation is still saved', async () => {
  stripeMode = 'error';
  const res = await checkout.handler(post(JSON.stringify({ reservationId: RESERVATION.id })));
  assert.strictEqual(res.statusCode, 502);
  assert.ok(/saved your reservation/i.test(JSON.parse(res.body).error));
});

test('rejects GET', async () => {
  const res = await checkout.handler({ httpMethod: 'GET', headers: {}, blobs: 'stub-credentials' });
  assert.strictEqual(res.statusCode, 405);
});

test('rejects a malformed body', async () => {
  const res = await checkout.handler(post('{not json'));
  assert.strictEqual(res.statusCode, 400);
});

// ================= stripe-webhook =========================================
const completed = (overrides = {}) => ({
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_test_123', amount_total: 2500, payment_intent: 'pi_1',
    metadata: { reservationId: RESERVATION.id }, ...overrides
  } }
});

test('a genuine signed webhook marks the deposit paid', async () => {
  const { body, headers } = signed(completed());
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 200);
  const saved = store.get(RESERVATION.id);
  assert.strictEqual(saved.depositStatus, 'paid');
  assert.strictEqual(saved.depositAmount, 2500);
  assert.ok(saved.paidAt);
});

test('AN UNSIGNED REQUEST CANNOT MARK ANYTHING PAID', async () => {
  const res = await webhook.handler(post(JSON.stringify(completed()), {}));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(store.get(RESERVATION.id).depositStatus, 'pending');
});

test('a forged signature cannot mark anything paid', async () => {
  const { body, headers } = signed(completed(), nowSec(), 'whsec_attacker');
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(store.get(RESERVATION.id).depositStatus, 'pending');
});

test('A REPLAYED OLD WEBHOOK IS REFUSED', async () => {
  const { body, headers } = signed(completed(), nowSec() - 7200);
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(store.get(RESERVATION.id).depositStatus, 'pending');
});

test('a tampered body — same signature, different reservation — is refused', async () => {
  const { body, headers } = signed(completed());
  const tampered = body.replace(RESERVATION.id, 'reservation-1770000000009-hacked');
  const res = await webhook.handler(post(tampered, headers));
  assert.strictEqual(res.statusCode, 401);
});

test('fails closed when no webhook secret is configured', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const { body, headers } = signed(completed());
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(store.get(RESERVATION.id).depositStatus, 'pending');
});

test('falls back to client_reference_id when metadata is missing', async () => {
  const { body, headers } = signed(completed({ metadata: {}, client_reference_id: RESERVATION.id }));
  await webhook.handler(post(body, headers));
  assert.strictEqual(store.get(RESERVATION.id).depositStatus, 'paid');
});

test('a repeated webhook does not overwrite the original paidAt', async () => {
  const { body, headers } = signed(completed());
  await webhook.handler(post(body, headers));
  const first = store.get(RESERVATION.id).paidAt;
  const again = signed(completed());
  const res = await webhook.handler(post(again.body, again.headers));
  assert.strictEqual(JSON.parse(res.body).handled, 'already-paid');
  assert.strictEqual(store.get(RESERVATION.id).paidAt, first);
});

test('200s (stops retries) for a session we have no reservation for', async () => {
  const { body, headers } = signed(completed({ metadata: { reservationId: 'reservation-1770000000002-nope11' } }));
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).handled, 'unknown-reservation');
});

test('500s (so Stripe retries) when storage is down — a payment must not be lost', async () => {
  failOnRead = true;
  const { body, headers } = signed(completed());
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 500);
});

test('ignores event types it does not handle', async () => {
  const { body, headers } = signed({ type: 'invoice.paid', data: { object: {} } });
  const res = await webhook.handler(post(body, headers));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).handled, 'ignored');
});

test('rejects GET', async () => {
  const res = await webhook.handler({ httpMethod: 'GET', headers: {}, blobs: 'stub-credentials' });
  assert.strictEqual(res.statusCode, 405);
});

(async () => {
  for (const [name, fn] of tests) {
    reset();
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
