/**
 * Admin auth tests.
 *
 * The trailing-whitespace case is here because it actually happened: the
 * supplied token was trimmed but the configured one was not, so a token pasted
 * into Netlify with a newline on the end could never match anything typed by a
 * human — and the only symptom was an unexplained "Unauthorised".
 */
const assert = require('node:assert');
const { checkAdminAuth, MIN_TOKEN_LENGTH } = require('../netlify/functions/_lib/auth.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const GOOD = 'purple-kettle-orbit-fence';
const ev = (token) => ({ headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

process.env.ADMIN_TOKEN = GOOD;
test('accepts the correct token', () =>
  assert.strictEqual(checkAdminAuth(ev(GOOD)).ok, true));

test('rejects a wrong token with 401', () =>
  assert.strictEqual(checkAdminAuth(ev('something-else-entirely')).status, 401));

test('rejects a missing header with 401', () =>
  assert.strictEqual(checkAdminAuth(ev(undefined)).status, 401));

// --- the whitespace bug -------------------------------------------------
process.env.ADMIN_TOKEN = GOOD + '\n';
test('a configured token with a trailing newline still accepts the clean token', () =>
  assert.strictEqual(checkAdminAuth(ev(GOOD)).ok, true));

process.env.ADMIN_TOKEN = '  ' + GOOD + '  ';
test('a configured token padded with spaces still accepts the clean token', () =>
  assert.strictEqual(checkAdminAuth(ev(GOOD)).ok, true));

process.env.ADMIN_TOKEN = GOOD;
test('a supplied token with surrounding whitespace is accepted', () =>
  assert.strictEqual(checkAdminAuth(ev(`  ${GOOD}  `)).ok, true));

// --- fail closed --------------------------------------------------------
delete process.env.ADMIN_TOKEN;
test('no configured token fails closed with 503, not open', () => {
  const r = checkAdminAuth(ev(GOOD));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 503);
});

process.env.ADMIN_TOKEN = 'short';
test('a too-short configured token fails closed with 503', () =>
  assert.strictEqual(checkAdminAuth(ev('short')).status, 503));

process.env.ADMIN_TOKEN = '                    ';
test('a whitespace-only configured token fails closed, not through', () => {
  const r = checkAdminAuth(ev(''));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 503);
});

// 12 is the owner's chosen floor. Pinned so it can't drift downwards by
// accident — anything below this is only safe because of the rate limiter.
test('minimum length is 12 or more', () => assert.ok(MIN_TOKEN_LENGTH >= 12));

process.env.ADMIN_TOKEN = 'elevenchars';  // 11
test('an 11-character configured token is still refused', () =>
  assert.strictEqual(checkAdminAuth(ev('elevenchars')).status, 503));

process.env.ADMIN_TOKEN = 'twelvechars1';  // 12
test('a 12-character configured token is accepted', () =>
  assert.strictEqual(checkAdminAuth(ev('twelvechars1')).ok, true));

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
