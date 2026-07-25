/**
 * Tests for the form-handling functions, run with `node --test`.
 *
 * These stub out @netlify/blobs so they can run anywhere — no Netlify account,
 * no network. The point is to pin down the behaviour that actually matters:
 *
 *  1. connectLambda(event) IS called before getStore(). Omitting it was the
 *     original production bug (MissingBlobsEnvironmentError), and it's
 *     invisible under `netlify dev`, so it needs a test to stay fixed.
 *  2. A storage failure returns 500, never 200. A false success here means a
 *     real customer enquiry is lost while they're told it arrived.
 *  3. Validation rejects missing fields with 400, and non-POST with 405.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// ---- stub @netlify/blobs before the functions require it ------------------
const calls = { connectLambda: [], getStore: [], setJSON: [] };
let failOnWrite = false;

const stub = {
  connectLambda(event) { calls.connectLambda.push(event); },
  getStore(name) {
    calls.getStore.push(name);
    return {
      async setJSON(key, value) {
        if (failOnWrite) throw new Error('simulated blob write failure');
        calls.setJSON.push({ store: name, key, value });
      }
    };
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, request, ...rest);
};
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', filename: '@netlify/blobs', loaded: true, exports: stub };

const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');
const load = (name) => require(path.join(FN_DIR, name));

const enquiry = load('submit-enquiry.js');
const quote = load('submit-quote.js');
const booking = load('submit-booking.js');
const interest = load('register-interest.js');

// Netlify injects credentials on event.blobs in Lambda compatibility mode.
const makeEvent = (body, method = 'POST') => ({
  httpMethod: method,
  body: body === undefined ? undefined : JSON.stringify(body),
  blobs: 'eyJzdHViIjp0cnVlfQ==',
  headers: {}
});

function reset() {
  calls.connectLambda.length = 0;
  calls.getStore.length = 0;
  calls.setJSON.length = 0;
  failOnWrite = false;
}

// --------------------------------------------------------------------------

test('the original bug: connectLambda is called with the event before getStore', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.connectLambda.length, 1, 'connectLambda must be called');
  assert.ok(calls.connectLambda[0].blobs, 'must receive the event carrying .blobs');
  assert.deepStrictEqual(calls.getStore, ['enquiries']);
});

test('a storage failure returns 500, never a false success', async () => {
  reset();
  failOnWrite = true;
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));

  assert.strictEqual(res.statusCode, 500, 'a lost enquiry must not report success');
  const body = JSON.parse(res.body);
  assert.ok(!body.ok);
  assert.match(body.error, /Could not store/);
});

test('submitted fields are persisted with an id and timestamp', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({
    name: 'Rob Brunt', email: 'rob@example.com', phone: '01202 000000',
    postcode: 'DT1 1AA', message: 'Panels look filthy'
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.setJSON.length, 1);
  const { key, value } = calls.setJSON[0];
  assert.match(key, /^enquiry-\d+-[a-z0-9]+$/);
  assert.strictEqual(value.name, 'Rob Brunt');
  assert.strictEqual(value.email, 'rob@example.com');
  assert.strictEqual(value.postcode, 'DT1 1AA');
  assert.ok(!Number.isNaN(Date.parse(value.receivedAt)), 'receivedAt must be a valid date');
  assert.strictEqual(JSON.parse(res.body).id, key);
});

test('missing required fields are rejected with 400 and nothing is stored', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({ email: 'rob@example.com' })); // no name
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /name/i);
  assert.strictEqual(calls.setJSON.length, 0);
});

test('whitespace-only values count as missing', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({ name: '   ', email: 'rob@example.com' }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls.setJSON.length, 0);
});

test('non-POST requests are rejected with 405', async () => {
  reset();
  const res = await enquiry.handler(makeEvent(undefined, 'GET'));
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(calls.connectLambda.length, 0);
});

test('a malformed JSON body is rejected with 400', async () => {
  reset();
  const res = await enquiry.handler({ httpMethod: 'POST', body: '{not json', blobs: 'x', headers: {} });
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Invalid JSON/);
});

test('quote requests validate company, contact and email', async () => {
  reset();
  assert.strictEqual((await quote.handler(makeEvent({ company: 'Acme' }))).statusCode, 400);

  reset();
  const ok = await quote.handler(makeEvent({
    company: 'Acme Farms', contact: 'Jo Bloggs', email: 'jo@acme.test',
    systemSize: '50', serviceLevel: 'full'
  }));
  assert.strictEqual(ok.statusCode, 200);
  assert.deepStrictEqual(calls.getStore, ['commercial-quotes']);
  assert.strictEqual(calls.setJSON[0].value.systemSize, '50');
});

test('bookings require a date and slot, and record them as requested', async () => {
  reset();
  assert.strictEqual(
    (await booking.handler(makeEvent({ name: 'Rob', email: 'r@e.test' }))).statusCode, 400,
    'a booking with no date/slot must be rejected'
  );

  reset();
  const ok = await booking.handler(makeEvent({
    name: 'Rob', email: 'r@e.test', date: '2026-08-03T09:00:00.000Z',
    slot: '9:00am – 11:00am', plan: 'standard'
  }));
  assert.strictEqual(ok.statusCode, 200);
  const v = calls.setJSON[0].value;
  assert.strictEqual(v.requestedDate, '2026-08-03T09:00:00.000Z');
  assert.strictEqual(v.requestedSlot, '9:00am – 11:00am');
  assert.strictEqual(v.plan, 'standard');
});

test('interest registrations need only an email and keep the coverage status', async () => {
  reset();
  assert.strictEqual((await interest.handler(makeEvent({ postcode: 'EX1' }))).statusCode, 400);

  reset();
  const ok = await interest.handler(makeEvent({
    email: 'someone@example.test', postcode: 'EX1 1AA', coverageStatus: 'soon'
  }));
  assert.strictEqual(ok.statusCode, 200);
  assert.deepStrictEqual(calls.getStore, ['interest-registrations']);
  assert.strictEqual(calls.setJSON[0].value.coverageStatus, 'soon');
  assert.strictEqual(calls.setJSON[0].value.name, null, 'optional name defaults to null');
});

test('every endpoint returns JSON content-type', async () => {
  reset();
  for (const fn of [enquiry, quote, booking, interest]) {
    const res = await fn.handler(makeEvent(undefined, 'GET'));
    assert.strictEqual(res.headers['Content-Type'], 'application/json');
  }
});
