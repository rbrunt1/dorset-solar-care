/**
 * Input-limit tests.
 *
 * The bias throughout is towards keeping a real enquiry: a long message is
 * TRUNCATED and stored, not rejected. Only an absurd body — far past anything a
 * person types — is refused. These tests pin both halves of that, because
 * getting it wrong in the strict direction silently loses customers.
 */
const assert = require('node:assert');
const {
  MAX_BODY_BYTES, FIELD_LIMITS, DEFAULT_FIELD_LIMIT, bodyBytes, isOversized, capFields
} = require('../netlify/functions/_lib/limits.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// ---- body size ---------------------------------------------------------
test('a normal enquiry is nowhere near the body limit', () => {
  const body = JSON.stringify({
    name: 'Wilhelmina Fotheringay', email: 'w@example.test', postcode: 'BH12 1AA',
    message: 'My inverter hums and output is down about 20% since the winter. '.repeat(10)
  });
  assert.ok(!isOversized(body), `a real enquiry must never be refused (${bodyBytes(body)} bytes)`);
});

test('the 5 MB body from the live probe is now refused', () => {
  assert.ok(isOversized(JSON.stringify({ message: 'A'.repeat(5 * 1024 * 1024) })));
});

test('1 MB is refused', () => {
  assert.ok(isOversized(JSON.stringify({ message: 'A'.repeat(1024 * 1024) })));
});

test('counts BYTES, not characters — multi-byte text must not sneak past', () => {
  // '£' is two bytes in UTF-8. A string half the character limit of pure
  // multi-byte text still exceeds the byte limit.
  const s = '£'.repeat(MAX_BODY_BYTES);
  assert.strictEqual(bodyBytes(s), MAX_BODY_BYTES * 2);
  assert.ok(isOversized(s));
});

test('an empty or missing body is not treated as oversized', () => {
  assert.ok(!isOversized(''));
  assert.ok(!isOversized(undefined));
  assert.ok(!isOversized(null));
});

// ---- field caps --------------------------------------------------------
test('a long message is TRUNCATED and kept, never dropped', () => {
  const { fields, truncated } = capFields({ message: 'x'.repeat(20000) });
  assert.strictEqual(fields.message.length, FIELD_LIMITS.message);
  assert.ok(truncated.some(t => t.startsWith('message(')), 'and it is reported');
});

test('an ordinary message is untouched', () => {
  const msg = 'Panels look filthy after the winter and output seems down.';
  const { fields, truncated } = capFields({ message: msg });
  assert.strictEqual(fields.message, msg);
  assert.deepStrictEqual(truncated, []);
});

test('every field a real person types fits comfortably', () => {
  const realistic = {
    name: 'Wilhelmina Fotheringay-Featherstonehaugh',
    email: 'wilhelmina.fotheringay@some-quite-long-domain-name.example.co.uk',
    phone: '+44 7700 900123', postcode: 'BH12 9ZZ', systemSize: '4.2 kWp'
  };
  const { truncated } = capFields(realistic);
  assert.deepStrictEqual(truncated, [], `nothing realistic should be cut: ${truncated}`);
});

test('the message limit is generous — 5000 characters', () => {
  assert.ok(FIELD_LIMITS.message >= 5000);
});

test('an unknown field still gets a default cap rather than being unbounded', () => {
  const { fields } = capFields({ somethingNew: 'y'.repeat(9999) });
  assert.strictEqual(fields.somethingNew.length, DEFAULT_FIELD_LIMIT);
});

test('non-string values pass through untouched', () => {
  const { fields } = capFields({ count: 42, flag: true, missing: null, nested: { a: 1 } });
  assert.strictEqual(fields.count, 42);
  assert.strictEqual(fields.flag, true);
  assert.strictEqual(fields.missing, null);
  assert.deepStrictEqual(fields.nested, { a: 1 });
});

test('handles empty input without throwing', () => {
  assert.deepStrictEqual(capFields({}).fields, {});
  assert.deepStrictEqual(capFields(null).fields, {});
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
