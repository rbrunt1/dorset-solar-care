/**
 * Bot-trap tests.
 *
 * The bias here is deliberate and worth stating: a discarded spam message costs
 * nothing, a discarded real enquiry costs a customer. So these tests are as
 * concerned with what must NOT be treated as a bot as with what must.
 */
const assert = require('node:assert');
const Module = require('node:module');

// Stub @netlify/blobs so requiring store.js doesn't need a Netlify account.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, request, ...rest);
};
require.cache['@netlify/blobs'] = {
  id: '@netlify/blobs', filename: '@netlify/blobs', loaded: true,
  exports: { connectLambda() {}, getStore() { return {}; } }
};

const {
  looksAutomated, cameFromRenderedForm, HONEYPOT_FIELD, MIN_FILL_MS
} = require('../netlify/functions/_lib/store.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const human = { name: 'Rob Brunt', postcode: 'BH12 1AA', _fillMs: 24000, [HONEYPOT_FIELD]: '' };

// --- must be caught -----------------------------------------------------
test('catches a filled honeypot', () =>
  assert.ok(looksAutomated({ ...human, [HONEYPOT_FIELD]: 'http://spam.example' })));

test('catches a honeypot filled with only a stray character', () =>
  assert.ok(looksAutomated({ ...human, [HONEYPOT_FIELD]: 'x' })));

test('catches an instant submission', () =>
  assert.ok(looksAutomated({ ...human, _fillMs: 40 })));

test('catches a submission just under the floor', () =>
  assert.ok(looksAutomated({ ...human, _fillMs: MIN_FILL_MS - 1 })));

test('the reason names the honeypot, so logs are diagnosable', () =>
  assert.match(looksAutomated({ ...human, [HONEYPOT_FIELD]: 'x' }), /honeypot/));

// --- must NOT be caught -------------------------------------------------
test('a normal submission passes', () =>
  assert.strictEqual(looksAutomated(human), null));

test('an empty honeypot passes', () =>
  assert.strictEqual(looksAutomated({ ...human, [HONEYPOT_FIELD]: '' }), null));

test('a whitespace-only honeypot passes (autofill can insert a space)', () =>
  assert.strictEqual(looksAutomated({ ...human, [HONEYPOT_FIELD]: '   ' }), null));

test('a MISSING timing value is not itself treated as automated', () =>
  assert.strictEqual(looksAutomated({ name: 'Rob', postcode: 'BH12 1AA' }), null));

test('a null timing value passes', () =>
  assert.strictEqual(looksAutomated({ ...human, _fillMs: null }), null));

test('a submission exactly on the floor passes', () =>
  assert.strictEqual(looksAutomated({ ...human, _fillMs: MIN_FILL_MS }), null));

test('a nonsense negative timing passes rather than being treated as a bot', () =>
  assert.strictEqual(looksAutomated({ ...human, _fillMs: -500 }), null));

test('a non-numeric timing value passes', () =>
  assert.strictEqual(looksAutomated({ ...human, _fillMs: 'quick' }), null));

test('someone taking twenty minutes over the form passes', () =>
  assert.strictEqual(looksAutomated({ ...human, _fillMs: 20 * 60 * 1000 }), null));

// --- robustness ---------------------------------------------------------
test('handles null input without throwing', () =>
  assert.strictEqual(looksAutomated(null), null));

test('handles a non-object without throwing', () =>
  assert.strictEqual(looksAutomated('not an object'), null));

test('the floor is 2.5 seconds', () => assert.strictEqual(MIN_FILL_MS, 2500));

test('a 2-second submission is now caught (it was not at the old 1.5s floor)', () =>
  assert.ok(looksAutomated({ ...human, _fillMs: 2000 })));

test('a 3-second submission still passes — fast autofilling humans exist', () =>
  assert.strictEqual(looksAutomated({ ...human, _fillMs: 3000 }), null));

// --- the structural check ------------------------------------------------
// The strongest of the three: a request that never rendered the page.
test('a real submission carries the honeypot key, empty but present', () =>
  assert.strictEqual(cameFromRenderedForm(human), true));

test('an empty-string honeypot still counts as present', () =>
  assert.strictEqual(cameFromRenderedForm({ [HONEYPOT_FIELD]: '' }), true));

test('a direct API POST with no honeypot key is rejected', () =>
  assert.strictEqual(cameFromRenderedForm({ name: 'Bot', email: 'b@example.com' }), false));

test('structural check handles null without throwing', () =>
  assert.strictEqual(cameFromRenderedForm(null), false));

test('structural check handles a non-object without throwing', () =>
  assert.strictEqual(cameFromRenderedForm('nope'), false));

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
