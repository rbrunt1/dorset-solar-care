/**
 * October reservation tests.
 *
 * This is the demand-validation step, so the thing that matters most is that a
 * real reservation is never lost and never silently mangled: the whole exercise
 * is counting who was willing to commit, and a miscount leads to the wrong
 * decision about whether the business has legs.
 */
const assert = require('node:assert');
const Module = require('node:module');

let stored = [];
const blobsStub = {
  connectLambda() {},
  getStore(name) {
    return {
      async get() { return null; },
      async setJSON(key, value) { stored.push({ store: name, key, value }); },
      async delete() {},
      async list() { return { blobs: [] }; }
    };
  }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, r, ...rest);
};
require.cache['@netlify/blobs'] = {
  id: '@netlify/blobs', filename: '@netlify/blobs', loaded: true, exports: blobsStub
};
delete process.env.RESEND_API_KEY;   // no outbound mail in tests

const fn = require('../netlify/functions/submit-reservation.js');
const { OFFERED_MONTHS, PLANS } = fn;

let passed = 0, failed = 0;
const real = console.log;
const test = (name, f) => Promise.resolve().then(f)
  .then(() => { real(`  PASS  ${name}`); passed++; })
  .catch(e => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });

const VALID = {
  name: 'Jane Smith', email: 'jane@example.test', phone: '07700900000',
  address1: '14 Elm Road', postcode: 'BH12 1AA',
  preferredMonth: '2026-10', plan: 'standard', panelAge: '2019',
  _hp_website: '', _fillMs: 45000
};
const evt = (body) => ({
  httpMethod: 'POST', body: JSON.stringify(body), blobs: 'stub',
  headers: { 'x-nf-client-connection-ip': `10.0.0.${Math.floor(Math.random() * 250)}` }
});
const reset = () => { stored = []; };
const reservation = () => stored.find(s => s.store === 'reservations');

(async () => {
  await test('a complete reservation is stored', async () => {
    reset();
    const res = await fn.handler(evt(VALID));
    assert.strictEqual(res.statusCode, 200);
    const r = reservation();
    assert.ok(r, 'must be written to the reservations store');
    assert.strictEqual(r.value.name, 'Jane Smith');
    assert.strictEqual(r.value.address1, '14 Elm Road');
    assert.strictEqual(r.value.postcode, 'BH12 1AA');
  });

  await test('the address IS required — a visit cannot be planned without one', async () => {
    reset();
    const { address1, ...noAddress } = VALID;
    const res = await fn.handler(evt(noAddress));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!reservation(), 'nothing stored');
  });

  await test('name, email and postcode are all required', async () => {
    for (const field of ['name', 'email', 'postcode']) {
      reset();
      const body = { ...VALID }; delete body[field];
      const res = await fn.handler(evt(body));
      assert.strictEqual(res.statusCode, 400, `${field} should be required`);
    }
  });

  await test('deposit starts unpaid, so nothing is ever assumed to be paid', async () => {
    reset();
    await fn.handler(evt(VALID));
    const v = reservation().value;
    assert.strictEqual(v.depositStatus, 'pending');
    assert.strictEqual(v.paidAt, null);
    assert.strictEqual(v.depositAmount, null);
  });

  await test('an unoffered month falls back rather than losing the reservation', async () => {
    reset();
    await fn.handler(evt({ ...VALID, preferredMonth: '2027-04' }));
    assert.strictEqual(reservation().value.preferredMonth, OFFERED_MONTHS[0],
      'a stale cached page must not cost a real reservation');
  });

  await test('an unknown plan becomes "undecided" rather than being stored as junk', async () => {
    reset();
    await fn.handler(evt({ ...VALID, plan: 'platinum-deluxe' }));
    assert.strictEqual(reservation().value.plan, 'undecided');
  });

  await test('plan is matched case-insensitively', async () => {
    reset();
    await fn.handler(evt({ ...VALID, plan: 'PREMIUM' }));
    assert.strictEqual(reservation().value.plan, 'premium');
  });

  await test('"not sure yet" is a valid answer and survives', async () => {
    reset();
    await fn.handler(evt({ ...VALID, plan: 'undecided' }));
    assert.strictEqual(reservation().value.plan, 'undecided');
    assert.ok(PLANS.includes('undecided'));
  });

  await test('optional fields default to null, not undefined or empty string', async () => {
    reset();
    const { phone, panelAge, ...minimal } = VALID;
    await fn.handler(evt(minimal));
    const v = reservation().value;
    assert.strictEqual(v.phone, null);
    assert.strictEqual(v.panelAge, null);
    assert.strictEqual(v.notes, null);
  });

  await test('the leaflet source is captured — this is how response gets measured', async () => {
    reset();
    await fn.handler(evt({ ...VALID, source: { utmSource: 'leaflet', utmCampaign: 'bh12-oct' } }));
    const s = reservation().value.source;
    assert.strictEqual(s.utmSource, 'leaflet');
    assert.strictEqual(s.utmCampaign, 'bh12-oct');
  });

  await test('a bot filling the honeypot is discarded, keeping the count honest', async () => {
    reset();
    const res = await fn.handler(evt({ ...VALID, _hp_website: 'http://spam.example' }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!reservation(), 'a fake reservation would corrupt the validation numbers');
  });

  await test('an instant submission is discarded too', async () => {
    reset();
    const res = await fn.handler(evt({ ...VALID, _fillMs: 30 }));
    assert.ok(!reservation());
  });

  await test('the offered months are the ones the page shows', () => {
    assert.deepStrictEqual(OFFERED_MONTHS, ['2026-10', '2026-11']);
  });

  real(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
