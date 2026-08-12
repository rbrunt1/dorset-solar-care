/**
 * Customer auto-reply tests.
 *
 * The rules that matter, in order:
 *   1. It must NEVER cost a lead. The enquiry is already stored by the time
 *      this runs, so no failure here may surface to the visitor.
 *   2. It must not send where it shouldn't — no email address, our own address,
 *      a form type with no template, or the feature switched off.
 *   3. What it says must be right: their details reflected accurately, the
 *      phone number present, and nothing that reads like marketing.
 */
const assert = require('node:assert');
const {
  buildAcknowledgement, sendAcknowledgement, looksLikeEmail,
  RESPONSE_TIME, CONTACT_PHONE, CONTACT_EMAIL
} = require('../netlify/functions/_lib/acknowledge.js');

let passed = 0, failed = 0;
const real = console.log;
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { real(`  PASS  ${name}`); passed++; })
  .catch(e => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });

// ---- capture outbound mail --------------------------------------------
let sent = [];
let mode = 'ok';
globalThis.fetch = async (url, opts = {}) => {
  sent.push(JSON.parse(opts.body || '{}'));
  if (mode === 'network') throw new Error('simulated network failure');
  if (mode === 'http-error') return { ok: false, status: 422, json: async () => ({ message: 'nope' }) };
  if (mode === 'hang') {
    return new Promise((_r, reject) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    });
  }
  return { ok: true, status: 200, json: async () => ({ id: 'ack-test-id' }) };
};
const reset = () => {
  sent = []; mode = 'ok';
  process.env.RESEND_API_KEY = 're_test';
  delete process.env.SEND_CUSTOMER_ACKNOWLEDGEMENT;
};

const ENQUIRY = {
  id: 'enquiry-1', name: 'Jane Smith', email: 'jane@example.test',
  phone: '07700900000', postcode: 'BH12 1AA',
  message: 'Panels look filthy after the winter'
};

(async () => {
  // ---- content ---------------------------------------------------------
  await test('greets the customer by first name only', () => {
    const b = buildAcknowledgement('enquiries', ENQUIRY);
    assert.match(b.text, /^Hi Jane,/);
    assert.ok(!b.text.includes('Hi Jane Smith'), 'surname is too formal here');
  });

  await test('falls back to a plain greeting with no name', () => {
    const b = buildAcknowledgement('enquiries', { email: 'x@y.test' });
    assert.match(b.text, /^Hi,/);
  });

  await test('reflects their details back, which is the actual reassurance', () => {
    const b = buildAcknowledgement('enquiries', ENQUIRY);
    assert.ok(b.text.includes('BH12 1AA'));
    assert.ok(b.text.includes('Panels look filthy after the winter'));
    assert.ok(b.html.includes('BH12 1AA'));
  });

  await test('always gives the phone number for anything urgent', () => {
    const b = buildAcknowledgement('enquiries', ENQUIRY);
    assert.ok(b.text.includes(CONTACT_PHONE));
    assert.ok(b.html.includes(CONTACT_PHONE));
  });

  await test('states when they will hear back', () => {
    const b = buildAcknowledgement('enquiries', ENQUIRY);
    assert.ok(b.text.includes(RESPONSE_TIME));
  });

  await test('a booking is described as a request, NOT a confirmed appointment', () => {
    const b = buildAcknowledgement('bookings', {
      name: 'Rob', email: 'r@e.test',
      requestedDate: '2026-08-03T09:00:00.000Z', requestedSlot: '9:00am – 11:00am'
    });
    assert.match(b.text, /request rather than a confirmed appointment/i,
      'promising a confirmed slot we have not confirmed would be a real problem');
  });

  await test('renders the requested date readably, not as an ISO string', () => {
    const b = buildAcknowledgement('bookings', {
      name: 'Rob', email: 'r@e.test', requestedDate: '2026-08-03T09:00:00.000Z'
    });
    assert.match(b.text, /Monday, 3 August 2026/);
    assert.ok(!b.text.includes('2026-08-03T09:00'));
  });

  await test('the area-interest reply promises no other marketing', () => {
    const b = buildAcknowledgement('interest-registrations', { email: 'x@y.test' });
    assert.match(b.text, /won't email you about anything else/i);
  });

  await test('every form type has its own copy', () => {
    for (const store of ['enquiries', 'bookings', 'commercial-quotes', 'interest-registrations']) {
      const b = buildAcknowledgement(store, { name: 'A', email: 'a@b.test' });
      assert.ok(b && b.subject && b.text && b.html, `${store} has no template`);
    }
  });

  await test('says plainly that it is a one-off, not a mailing list', () => {
    const b = buildAcknowledgement('enquiries', ENQUIRY);
    assert.match(b.text, /not a mailing list/i);
  });

  await test('escapes HTML so a hostile name cannot inject markup', () => {
    const b = buildAcknowledgement('enquiries', {
      name: '<script>alert(1)</script>', email: 'x@y.test'
    });
    assert.ok(!b.html.includes('<script>alert(1)</script>'));
    assert.ok(b.html.includes('&lt;script&gt;'));
  });

  await test('omits fields the customer left blank rather than showing them empty', () => {
    const b = buildAcknowledgement('enquiries', { name: 'Jo', email: 'jo@e.test' });
    assert.ok(!b.text.includes('Phone:'));
    assert.ok(!/null|undefined/.test(b.text));
  });

  // ---- when it must NOT send ------------------------------------------
  await test('does not send without an email address', async () => {
    reset();
    const r = await sendAcknowledgement('enquiries', { name: 'No Email' });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'no-usable-email');
    assert.strictEqual(sent.length, 0);
  });

  await test('does not send to a malformed address', async () => {
    reset();
    const r = await sendAcknowledgement('enquiries', { email: 'not-an-address' });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(sent.length, 0);
  });

  await test('never auto-replies to our own inbox (no self-sent mail)', async () => {
    reset();
    const r = await sendAcknowledgement('enquiries', { email: CONTACT_EMAIL });
    assert.strictEqual(r.reason, 'own-address');
    assert.strictEqual(sent.length, 0);
  });

  await test('can be switched off without a code change', async () => {
    reset();
    process.env.SEND_CUSTOMER_ACKNOWLEDGEMENT = 'false';
    const r = await sendAcknowledgement('enquiries', ENQUIRY);
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(sent.length, 0);
  });

  await test('does nothing without an API key', async () => {
    reset();
    delete process.env.RESEND_API_KEY;
    const r = await sendAcknowledgement('enquiries', ENQUIRY);
    assert.strictEqual(r.sent, false);
    assert.strictEqual(sent.length, 0);
  });

  await test('skips a form type with no template rather than sending something odd', async () => {
    reset();
    const r = await sendAcknowledgement('some-future-form', ENQUIRY);
    assert.strictEqual(r.reason, 'no-template');
    assert.strictEqual(sent.length, 0);
  });

  // ---- when it does send ----------------------------------------------
  await test('sends to the customer, with replies coming back to the business', async () => {
    reset();
    const r = await sendAcknowledgement('enquiries', ENQUIRY);
    assert.strictEqual(r.sent, true);
    assert.deepStrictEqual(sent[0].to, ['jane@example.test']);
    assert.strictEqual(sent[0].reply_to, CONTACT_EMAIL);
    assert.match(sent[0].from, /solarmot\.co\.uk/);
  });

  await test('sends both plain text and HTML', async () => {
    reset();
    await sendAcknowledgement('enquiries', ENQUIRY);
    assert.ok(sent[0].text && sent[0].html);
  });

  // ---- failure must never escape --------------------------------------
  await test('an HTTP error is reported, not thrown', async () => {
    reset(); mode = 'http-error';
    const r = await sendAcknowledgement('enquiries', ENQUIRY);
    assert.strictEqual(r.sent, false);
    assert.match(r.reason, /^http-422$/);
  });

  await test('a network failure is reported, not thrown', async () => {
    reset(); mode = 'network';
    const r = await sendAcknowledgement('enquiries', ENQUIRY);
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'network');
  });

  await test('a hanging request is abandoned rather than blocking', async () => {
    reset(); mode = 'hang';
    const started = Date.now();
    const r = await sendAcknowledgement('enquiries', ENQUIRY);
    assert.strictEqual(r.reason, 'timeout');
    assert.ok(Date.now() - started < 8000);
  });

  // ---- helper ----------------------------------------------------------
  await test('looksLikeEmail accepts real addresses and rejects junk', () => {
    assert.ok(looksLikeEmail('a.b-c@example.co.uk'));
    assert.ok(!looksLikeEmail('a@b'));
    assert.ok(!looksLikeEmail('no-at-sign'));
    assert.ok(!looksLikeEmail(''));
    assert.ok(!looksLikeEmail(null));
  });


  // ---- reservations -------------------------------------------------------
  // A reservation is the only form where money changes hands, so the auto-reply
  // has to carry the refund terms in writing. The reserve page promises "a
  // confirmation email is on its way"; these tests are what stop that being a
  // lie.
  await test('a reservation gets an acknowledgement at all', () => {
    const built = buildAcknowledgement('reservations', {
      name: 'Jane Smith', email: 'jane@example.com',
      address1: '12 Elm Road', postcode: 'BH12 1AA', preferredMonth: '2026-10'
    });
    assert.ok(built, 'the reserve page promises this email — it must exist');
    assert.match(built.subject, /reserved/i);
  });

  await test('the reservation reply states the deposit is refundable and comes off month one', () => {
    const built = buildAcknowledgement('reservations', { name: 'Jane', email: 'jane@example.com' });
    assert.match(built.text, /refundable/i);
    assert.match(built.text, /comes off your first month/i);
    assert.match(built.html, /refundable/i);
  });

  await test('reads the month back as English, not as a database value', () => {
    const built = buildAcknowledgement('reservations', {
      name: 'Jane', email: 'jane@example.com', preferredMonth: '2026-10'
    });
    assert.match(built.text, /October 2026/);
    assert.ok(!built.text.includes('2026-10'), 'raw 2026-10 should not reach the customer');
  });

  await test('does not read back "Undecided" as if it were a plan', () => {
    const built = buildAcknowledgement('reservations', {
      name: 'Jane', email: 'jane@example.com', plan: 'undecided'
    });
    assert.ok(!/Undecided/i.test(built.text), 'an undecided plan is not a plan');
  });

  await test('reflects a chosen plan back when there is one', () => {
    const built = buildAcknowledgement('reservations', {
      name: 'Jane', email: 'jane@example.com', plan: 'standard'
    });
    assert.match(built.text, /Plan: Standard/);
  });

  await test('echoes the address so the customer can check we have it right', () => {
    const built = buildAcknowledgement('reservations', {
      name: 'Jane', email: 'jane@example.com', address1: '12 Elm Road', postcode: 'BH12 1AA'
    });
    assert.match(built.text, /12 Elm Road/);
    assert.match(built.text, /BH12 1AA/);
  });

  await test('a nonsense month falls back to showing it rather than crashing', () => {
    const built = buildAcknowledgement('reservations', {
      name: 'Jane', email: 'jane@example.com', preferredMonth: 'not-a-month'
    });
    assert.ok(built);
    assert.match(built.text, /not-a-month/);
  });

  real(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
