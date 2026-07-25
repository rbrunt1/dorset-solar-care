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
 *  4. Notification email problems NEVER cost a lead — a Resend outage, a
 *     missing key or a hang must still leave the record stored and the
 *     visitor shown success.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// ---- stub @netlify/blobs before the functions require it ------------------
const calls = { connectLambda: [], getStore: [], setJSON: [] };
let failOnWrite = false;

// ---- capture outbound email without touching the network ------------------
const emails = [];
let emailMode = 'ok'; // 'ok' | 'http-error' | 'network-error' | 'hang'
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.resend.com')) {
    emails.push({ url: String(url), headers: opts.headers || {}, body: JSON.parse(opts.body || '{}') });
    if (emailMode === 'network-error') throw new Error('simulated network failure');
    if (emailMode === 'http-error') {
      return { ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) };
    }
    if (emailMode === 'hang') {
      // Respect the abort signal the notifier passes, like a real hung request.
      return new Promise((_resolve, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
          });
        }
      });
    }
    return { ok: true, status: 200, json: async () => ({ id: 'resend-test-id' }) };
  }
  return realFetch ? realFetch(url, opts) : Promise.reject(new Error('unexpected fetch'));
};

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
  emails.length = 0;
  emailMode = 'ok';
  // Most tests run with notifications enabled; the no-key case sets this itself.
  process.env.RESEND_API_KEY = 're_test_key';
  delete process.env.LEAD_NOTIFICATION_TO;
  delete process.env.LEAD_NOTIFICATION_FROM;
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
    name: 'Rob Brunt', email: 'rob@example.com', phone: '07891 110865',
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

// ===========================================================================
// Notification emails
//
// The overriding rule: the submission is already stored by the time we try to
// email, so NOTHING about email may turn a saved lead into a failure.
// ===========================================================================

test('a successful submission sends a notification email', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({
    name: 'Rob Brunt', email: 'rob@example.com', postcode: 'DT1 1AA', message: 'Panels are filthy'
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).notified, true);
  assert.strictEqual(emails.length, 1, 'exactly one email per submission');

  const sent = emails[0];
  assert.match(sent.headers.Authorization, /^Bearer re_test_key$/);
  assert.deepStrictEqual(sent.body.to, ['robertbrunt@hotmail.co.uk']);
  assert.match(sent.body.subject, /New enquiry/);
  assert.match(sent.body.subject, /Rob Brunt/);
  // Replying should reach the customer, not us.
  assert.strictEqual(sent.body.reply_to, 'rob@example.com');
  // Both formats, and the details must actually be present.
  assert.ok(sent.body.text.includes('DT1 1AA'));
  assert.ok(sent.body.html.includes('Panels are filthy'));
});

test('a Resend HTTP error still returns 200 and keeps the stored lead', async () => {
  reset();
  emailMode = 'http-error';
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));

  assert.strictEqual(res.statusCode, 200, 'a failed email must NOT fail the submission');
  assert.strictEqual(JSON.parse(res.body).ok, true);
  assert.strictEqual(JSON.parse(res.body).notified, false, 'but it must report the email did not send');
  assert.strictEqual(calls.setJSON.length, 1, 'the lead is still stored');
});

test('a network failure talking to Resend still returns 200', async () => {
  reset();
  emailMode = 'network-error';
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.setJSON.length, 1);
  assert.strictEqual(JSON.parse(res.body).notified, false);
});

test('a hanging Resend request is abandoned and does not fail the submission', async () => {
  reset();
  emailMode = 'hang';
  const started = Date.now();
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));
  const elapsed = Date.now() - started;

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).notified, false);
  assert.ok(elapsed < 8000, `should abort around 5s, took ${elapsed}ms`);
});

test('with no API key, submissions still succeed and no email is attempted', async () => {
  reset();
  delete process.env.RESEND_API_KEY;
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.setJSON.length, 1, 'lead still stored without a key');
  assert.strictEqual(emails.length, 0, 'no outbound call without a key');
  assert.strictEqual(JSON.parse(res.body).notified, false);
});

test('a storage failure sends no email at all', async () => {
  reset();
  failOnWrite = true;
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(emails.length, 0, 'never notify about a lead that was not saved');
});

test('validation failures send no email', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({ email: 'rob@example.com' }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(emails.length, 0);
});

test('the recipient and sender are overridable by env var', async () => {
  reset();
  process.env.LEAD_NOTIFICATION_TO = 'a@solarmot.co.uk, b@solarmot.co.uk';
  process.env.LEAD_NOTIFICATION_FROM = 'SolarMOT <leads@solarmot.co.uk>';
  await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));

  assert.deepStrictEqual(emails[0].body.to, ['a@solarmot.co.uk', 'b@solarmot.co.uk']);
  assert.strictEqual(emails[0].body.from, 'SolarMOT <leads@solarmot.co.uk>');
});

test('each form type produces its own subject line and fields', async () => {
  reset();
  await quote.handler(makeEvent({ company: 'Acme Farms', contact: 'Jo', email: 'jo@acme.test', systemSize: '50' }));
  assert.match(emails[0].body.subject, /New commercial quote request/);
  assert.ok(emails[0].body.text.includes('Acme Farms'));
  assert.ok(emails[0].body.text.includes('50'));

  reset();
  await booking.handler(makeEvent({ name: 'Rob', email: 'r@e.test', date: '2026-08-03T09:00:00.000Z', slot: '9:00am - 11:00am' }));
  assert.match(emails[0].body.subject, /New booking request/);
  assert.ok(emails[0].body.text.includes('9:00am - 11:00am'));

  reset();
  await interest.handler(makeEvent({ email: 'someone@example.test', postcode: 'EX1 1AA', coverageStatus: 'soon' }));
  assert.match(emails[0].body.subject, /New interest registration/);
  // The raw status is translated into something meaningful to read.
  assert.ok(emails[0].body.text.includes('Year 2 area'), 'coverage status should be human-readable');
});

test('HTML in submitted values is escaped, not injected into the email', async () => {
  reset();
  await enquiry.handler(makeEvent({
    name: '<script>alert(1)</script>', email: 'x@y.test', message: 'a & b <b>bold</b>'
  }));
  const html = emails[0].body.html;
  assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag must not survive into the HTML body');
  assert.ok(html.includes('&lt;script&gt;'), 'it should appear escaped instead');
  assert.ok(html.includes('a &amp; b'), 'ampersands escaped');
});

test('empty optional fields are omitted from the email rather than shown blank', async () => {
  reset();
  await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));
  const text = emails[0].body.text;
  assert.ok(!/Phone:/.test(text), 'a null phone should not appear at all');
  assert.ok(!/null/.test(text), 'no raw nulls should leak into the email');
});

// ---- lead attribution ------------------------------------------------------

test('attribution is stored alongside the lead and reaches the email', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({
    name: 'Rob', email: 'rob@example.com',
    source: {
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'spring-clean',
      landingPage: '/pricing', referrer: 'https://www.google.com/'
    }
  }));

  assert.strictEqual(res.statusCode, 200);
  const stored = calls.setJSON[0].value;
  assert.strictEqual(stored.source.utmSource, 'google');
  assert.strictEqual(stored.source.landingPage, '/pricing');
  // and it must be legible in the notification, not "[object Object]"
  const body = emails[0].body;
  assert.ok(!/\[object Object\]/.test(body.html), 'source must be formatted, not stringified');
  assert.match(body.html, /google \/ cpc/);
  assert.match(body.html, /spring-clean/);
});

test('a missing source never blocks a lead', async () => {
  reset();
  const res = await enquiry.handler(makeEvent({ name: 'Rob', email: 'rob@example.com' }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.setJSON[0].value.source, null);
});

test('hostile or junk source values are rejected, not stored', async () => {
  reset();
  const { cleanSource } = require(path.join(FN_DIR, '_lib', 'store.js'));

  // unknown keys dropped
  assert.deepStrictEqual(cleanSource({ evil: 'x', utmSource: 'fb' }), { utmSource: 'fb' });
  // non-objects rejected
  assert.strictEqual(cleanSource('utmSource=fb'), null);
  assert.strictEqual(cleanSource(['a']), null);
  assert.strictEqual(cleanSource(null), null);
  // empty object -> null rather than an empty record field
  assert.strictEqual(cleanSource({}), null);
  // absurd lengths are capped
  const long = cleanSource({ referrer: 'x'.repeat(5000) });
  assert.strictEqual(long.referrer.length, 500);
});

test('a form field cannot overwrite the attribution object', async () => {
  reset();
  // "source" arriving as a plain string (e.g. a stray form input) must not
  // end up masquerading as attribution data.
  const res = await enquiry.handler(makeEvent({
    name: 'Rob', email: 'rob@example.com', source: 'not-an-object'
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.setJSON[0].value.source, null);
});
