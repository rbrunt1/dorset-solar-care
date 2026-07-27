/**
 * Logging tests.
 *
 * The property that matters most here is a NEGATIVE one: a normal submission
 * must not put the customer's name, email, phone, postcode or message into the
 * function logs. Netlify's logs sit outside the Blobs store the privacy policy
 * describes, are readable by anyone with dashboard access, and are retained on
 * Netlify's schedule rather than the business's. Personal data should not be
 * casually duplicated there.
 *
 * The one sanctioned exception is a storage failure, where the log becomes the
 * only surviving copy of a real enquiry. That case is tested explicitly too,
 * because silently dropping the recovery copy would be just as bad a bug.
 */
const assert = require('node:assert');
const Module = require('node:module');

// ---- stubs -------------------------------------------------------------
let failOnWrite = false;
const blobsStub = {
  connectLambda() {},
  getStore() {
    return { async setJSON() { if (failOnWrite) throw new Error('simulated blob failure'); } };
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

// No API key, so no outbound email is attempted.
delete process.env.RESEND_API_KEY;

const { handleSubmission } = require('../netlify/functions/_lib/store.js');
const { describe, describeSource, requestId } = require('../netlify/functions/_lib/log.js');

// ---- capture everything written to the log -----------------------------
let captured = [];
const real = { log: console.log, warn: console.warn, error: console.error };
function startCapture() {
  captured = [];
  for (const k of ['log', 'warn', 'error']) {
    console[k] = (...args) => captured.push(args.map(a => String(a)).join(' '));
  }
}
const stopCapture = () => Object.assign(console, real);
const allLogs = () => captured.join('\n');

let passed = 0, failed = 0;
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { real.log(`  PASS  ${name}`); passed++; })
  .catch(e => { real.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });

// Deliberately distinctive values so a leak is unambiguous.
const CUSTOMER = {
  name: 'Wilhelmina Fotheringay',
  email: 'wilhelmina@example-domain.test',
  phone: '07700900123',
  postcode: 'BH12 9ZZ',
  message: 'My inverter makes a peculiar humming noise',
  _hp_website: '',
  _fillMs: 41000
};
const PII = [CUSTOMER.name, CUSTOMER.email, CUSTOMER.phone, CUSTOMER.postcode, CUSTOMER.message];

const opts = {
  storeName: 'enquiries', prefix: 'enquiry', required: ['name', 'email'],
  build: (d) => ({ name: d.name, email: d.email, phone: d.phone || null,
                   postcode: d.postcode || null, message: d.message || null })
};
const evt = (body, rid = 'req-abc-123') => ({
  httpMethod: 'POST',
  body: JSON.stringify(body),
  blobs: 'stub',
  headers: { 'x-nf-request-id': rid }
});

(async () => {
  // --- the negative property -------------------------------------------
  await test('a successful submission leaks NO customer data into the logs', async () => {
    failOnWrite = false;
    startCapture();
    const res = await handleSubmission(evt(CUSTOMER), opts);
    stopCapture();
    assert.strictEqual(res.statusCode, 200);
    for (const value of PII) {
      assert.ok(!allLogs().includes(value),
        `log leaked ${JSON.stringify(value.slice(0, 20))}…\n${allLogs()}`);
    }
  });

  await test('but it still records that a submission arrived and completed', async () => {
    failOnWrite = false;
    startCapture();
    await handleSubmission(evt(CUSTOMER), opts);
    stopCapture();
    assert.match(allLogs(), /received/, 'should log arrival');
    assert.match(allLogs(), /stored/, 'should log storage');
    assert.match(allLogs(), /complete/, 'should log the outcome');
  });

  await test('every line carries the request id, so one submission can be traced', async () => {
    startCapture();
    await handleSubmission(evt(CUSTOMER, 'req-trace-me'), opts);
    stopCapture();
    const lines = captured.filter(l => l.includes('[enquiries]'));
    assert.ok(lines.length >= 3, 'expected several lines');
    for (const l of lines) assert.match(l, /rid=req-trace-me/, `line without rid: ${l}`);
  });

  await test('the log names which fields were present, without their values', async () => {
    startCapture();
    await handleSubmission(evt(CUSTOMER), opts);
    stopCapture();
    assert.match(allLogs(), /fields=.*email/, 'should say an email was supplied');
    assert.ok(!allLogs().includes(CUSTOMER.email), 'but not what it was');
  });

  // --- the sanctioned exception ----------------------------------------
  await test('a STORAGE FAILURE does log the full record, so the lead is recoverable', async () => {
    failOnWrite = true;
    startCapture();
    const res = await handleSubmission(evt(CUSTOMER), opts);
    stopCapture();
    failOnWrite = false;

    assert.strictEqual(res.statusCode, 500, 'must not report success');
    assert.match(allLogs(), /LEAD_RECOVERY/, 'the recovery copy must be clearly marked');
    assert.ok(allLogs().includes(CUSTOMER.email),
      'the whole point: the enquiry must survive somewhere');
    assert.ok(allLogs().includes(CUSTOMER.message));
  });

  // --- failure paths are visible ---------------------------------------
  await test('a validation failure is logged with the missing fields', async () => {
    startCapture();
    const res = await handleSubmission(evt({ email: 'a@b.test', _hp_website: '', _fillMs: 9000 }), opts);
    stopCapture();
    assert.strictEqual(res.statusCode, 400);
    assert.match(allLogs(), /missing-fields/);
    assert.match(allLogs(), /missing=name/);
  });

  await test('a discarded bot submission says why', async () => {
    startCapture();
    await handleSubmission(evt({ ...CUSTOMER, _hp_website: 'spam' }), opts);
    stopCapture();
    assert.match(allLogs(), /discarded/);
    assert.match(allLogs(), /honeypot/);
  });

  await test('a submission with no trap fields is logged as rejected', async () => {
    startCapture();
    await handleSubmission(evt({ name: 'Bot', email: 'b@b.test' }), opts);
    stopCapture();
    assert.match(allLogs(), /no-evidence-of-rendered-form/);
  });

  await test('malformed JSON is logged rather than failing silently', async () => {
    startCapture();
    const res = await handleSubmission(
      { httpMethod: 'POST', body: '{oops', blobs: 'x', headers: {} }, opts);
    stopCapture();
    assert.strictEqual(res.statusCode, 400);
    assert.match(allLogs(), /malformed-json/);
  });

  // --- the helpers ------------------------------------------------------
  await test('describe() lists present and missing fields but no values', () => {
    const out = describe(CUSTOMER, { expected: ['name', 'email', 'vatNumber'] });
    assert.match(out, /fields=/);
    assert.match(out, /missing=vatNumber/);
    for (const value of PII) assert.ok(!out.includes(value));
  });

  await test('describe() never reveals the honeypot or timing plumbing', () => {
    const out = describe(CUSTOMER);
    assert.ok(!out.includes('_hp_website'));
    assert.ok(!out.includes('_fillMs'));
  });

  await test('describeSource() reduces a referrer to a hostname only', () => {
    assert.strictEqual(
      describeSource({ referrer: 'https://www.google.com/search?q=very+private+search+terms' }),
      'source=www.google.com');
  });

  await test('describeSource() handles utm and direct', () => {
    assert.strictEqual(describeSource({ utmSource: 'google', utmMedium: 'cpc' }), 'source=google/cpc');
    assert.strictEqual(describeSource({ referrer: 'direct' }), 'source=direct');
    assert.strictEqual(describeSource(null), 'source=none');
  });

  await test('requestId() falls back cleanly when the header is absent', () => {
    assert.strictEqual(requestId({ headers: {} }), '-');
    assert.strictEqual(requestId({}), '-');
  });

  real.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
