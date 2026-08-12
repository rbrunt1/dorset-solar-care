/**
 * Stripe deposit tests.
 *
 * Two things carry real money risk and are tested hardest:
 *
 *  1. The AMOUNT must come from the server. If a browser could name its own
 *     price, anyone could reserve a slot for a penny and the validation
 *     exercise would be worthless.
 *  2. The webhook signature must be genuine AND recent. Without the timestamp
 *     check, anyone who ever captured one valid webhook could replay it
 *     forever and keep marking deposits paid.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyWebhook, formEncode, depositPence } = require('../netlify/functions/_lib/stripe.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const SECRET = 'whsec_test_secret_value';
const now = () => Math.floor(Date.now() / 1000);
const sign = (body, ts = now(), secret = SECRET) =>
  `t=${ts},v1=` + crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');

const BODY = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

// ---- the amount --------------------------------------------------------
test('the deposit defaults to £25', () => {
  delete process.env.DEPOSIT_AMOUNT_PENCE;
  assert.strictEqual(depositPence(), 2500);
});

test('the deposit can be changed by env var', () => {
  process.env.DEPOSIT_AMOUNT_PENCE = '1500';
  assert.strictEqual(depositPence(), 1500);
});

test('an absurd or mistyped amount falls back to £25 rather than charging it', () => {
  for (const bad of ['0', '1', '999999', 'twenty', '']) {
    process.env.DEPOSIT_AMOUNT_PENCE = bad;
    assert.strictEqual(depositPence(), 2500, `${bad} should not be charged`);
  }
  delete process.env.DEPOSIT_AMOUNT_PENCE;
});

// ---- form encoding (Stripe is not JSON) --------------------------------
test('nests objects the way Stripe expects', () => {
  assert.strictEqual(formEncode({ metadata: { reservationId: 'r-1' } }),
                     'metadata%5BreservationId%5D=r-1');
});

test('indexes arrays the way Stripe expects', () => {
  const out = formEncode({ line_items: [{ quantity: 1 }] });
  assert.strictEqual(decodeURIComponent(out), 'line_items[0][quantity]=1');
});

test('skips null and undefined rather than sending the string "null"', () => {
  assert.strictEqual(formEncode({ a: null, b: undefined, c: 'x' }), 'c=x');
});

test('escapes values that would otherwise break the encoding', () => {
  const out = formEncode({ description: 'SolarMOT deposit — BH12 1AA & co' });
  assert.ok(!out.includes(' '), 'spaces must be escaped');
  assert.ok(!out.includes('&co'), 'ampersands must be escaped, not treated as separators');
});

// ---- webhook signature -------------------------------------------------
test('accepts a correctly signed, current webhook', () => {
  assert.strictEqual(verifyWebhook(BODY, sign(BODY), SECRET), true);
});

test('rejects a tampered body', () => {
  const good = sign(BODY);
  assert.strictEqual(verifyWebhook(BODY.replace('cs_1', 'cs_2'), good, SECRET), false);
});

test('rejects a signature made with a different secret', () => {
  assert.strictEqual(verifyWebhook(BODY, sign(BODY, now(), 'whsec_attacker'), SECRET), false);
});

test('REJECTS A REPLAY — an old but genuine signature is refused', () => {
  const old = now() - 3600;
  assert.strictEqual(verifyWebhook(BODY, sign(BODY, old), SECRET), false,
    'without this, one captured webhook could mark deposits paid forever');
});

test('rejects a timestamp far in the future', () => {
  assert.strictEqual(verifyWebhook(BODY, sign(BODY, now() + 3600), SECRET), false);
});

test('accepts a signature within the tolerance window', () => {
  assert.strictEqual(verifyWebhook(BODY, sign(BODY, now() - 60), SECRET), true);
});

test('accepts when any of several v1 signatures matches (secret rotation)', () => {
  const ts = now();
  const valid = crypto.createHmac('sha256', SECRET).update(`${ts}.${BODY}`, 'utf8').digest('hex');
  assert.strictEqual(verifyWebhook(BODY, `t=${ts},v1=deadbeef,v1=${valid}`, SECRET), true);
});

test('rejects a missing or malformed header without throwing', () => {
  assert.strictEqual(verifyWebhook(BODY, undefined, SECRET), false);
  assert.strictEqual(verifyWebhook(BODY, 'nonsense', SECRET), false);
  assert.strictEqual(verifyWebhook(BODY, 't=abc,v1=x', SECRET), false);
  assert.strictEqual(verifyWebhook(BODY, `t=${now()}`, SECRET), false);
});

test('rejects when no secret is configured — fails closed', () => {
  assert.strictEqual(verifyWebhook(BODY, sign(BODY), ''), false);
});

test('rejects a truncated signature without throwing', () => {
  const ts = now();
  const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${BODY}`, 'utf8').digest('hex');
  assert.strictEqual(verifyWebhook(BODY, `t=${ts},v1=${sig.slice(0, 20)}`, SECRET), false);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
