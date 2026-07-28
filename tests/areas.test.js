/**
 * Area-expansion tests.
 *
 * This is the only bulk-email path in the system, and it cannot be undone, so
 * the tests lean hard on the things that would be embarrassing in front of real
 * people: emailing someone twice, emailing the wrong area, or losing track of
 * who has been told when something fails half way through.
 */
const assert = require('node:assert');
const {
  areaPrefix, groupByArea, selectRecipients, buildAreaEmail, notifyArea
} = require('../netlify/functions/_lib/areas.js');

let passed = 0, failed = 0;
const real = console.log;
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { real(`  PASS  ${name}`); passed++; })
  .catch(e => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; });

// ---- fixtures ----------------------------------------------------------
const LIST = [
  { id: 'i1', email: 'a@e.test', name: 'Ann',  postcode: 'SO16 4GX', receivedAt: '2026-01-01' },
  { id: 'i2', email: 'b@e.test', name: 'Bob',  postcode: 'so15 2aa', receivedAt: '2026-01-02' },
  { id: 'i3', email: 'c@e.test', name: 'Cara', postcode: 'TA1 1AA',  receivedAt: '2026-01-03' },
  { id: 'i4', email: 'd@e.test', name: 'Dev',  postcode: 'SO14 7XX',
    receivedAt: '2026-01-04', notifiedAt: '2026-02-01T00:00:00Z', notifiedForArea: 'SO' },
  { id: 'i5', email: '',         name: 'Eve',  postcode: 'SO17 1AA', receivedAt: '2026-01-05' },
  { id: 'i6', email: 'f@e.test', name: 'Fay',  postcode: null,       receivedAt: '2026-01-06' }
];

// ---- outbound capture ---------------------------------------------------
let sent = [];
let failFor = new Set();
globalThis.fetch = async (_url, opts = {}) => {
  const body = JSON.parse(opts.body || '{}');
  sent.push(body);
  if (failFor.has(body.to[0])) return { ok: false, status: 500, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

function makeStore({ failWrites = new Set() } = {}) {
  const written = new Map();
  return {
    written,
    store: {
      async setJSON(k, v) {
        if (failWrites.has(k)) throw new Error('simulated write failure');
        written.set(k, v);
      }
    }
  };
}
const reset = () => { sent = []; failFor = new Set(); };

(async () => {
  // ---- prefix parsing --------------------------------------------------
  await test('reads the area letters from a postcode', () => {
    assert.strictEqual(areaPrefix('SO16 4GX'), 'SO');
    assert.strictEqual(areaPrefix('b31 2aa'), 'B');
    assert.strictEqual(areaPrefix('EC1A 1BB'), 'EC');
  });

  await test('returns empty for junk rather than guessing an area', () => {
    assert.strictEqual(areaPrefix(''), '');
    assert.strictEqual(areaPrefix(null), '');
    assert.strictEqual(areaPrefix('not a postcode'), '');
  });

  // ---- grouping --------------------------------------------------------
  await test('groups by area with the most people still waiting first', () => {
    const groups = groupByArea(LIST);
    assert.strictEqual(groups[0].prefix, 'SO');
    assert.strictEqual(groups[0].waiting, 3, 'Ann, Bob and Eve are still waiting');
    assert.strictEqual(groups[0].notified, 1, 'Dev has already been told');
    assert.strictEqual(groups[0].total, 4);
  });

  await test('postcodes it cannot parse are grouped as Unknown, not dropped', () => {
    const groups = groupByArea(LIST);
    const unknown = groups.find(g => g.prefix === 'Unknown');
    assert.ok(unknown, 'a registration with no postcode must still be visible');
    assert.strictEqual(unknown.total, 1);
  });

  // ---- selection -------------------------------------------------------
  await test('selects only the requested area', () => {
    const { willSend } = selectRecipients(LIST, 'TA');
    assert.deepStrictEqual(willSend.map(r => r.id), ['i3']);
  });

  await test('is case-insensitive about the area given', () => {
    assert.strictEqual(selectRecipients(LIST, 'so').willSend.length,
                       selectRecipients(LIST, 'SO').willSend.length);
  });

  await test('EXCLUDES anyone already notified', () => {
    const { willSend, skipped } = selectRecipients(LIST, 'SO');
    assert.ok(!willSend.some(r => r.id === 'i4'), 'Dev must not be emailed twice');
    assert.ok(skipped.some(s => s.id === 'i4' && /already notified/.test(s.reason)));
  });

  await test('excludes registrations with no usable email, and says so', () => {
    const { willSend, skipped } = selectRecipients(LIST, 'SO');
    assert.ok(!willSend.some(r => r.id === 'i5'));
    assert.ok(skipped.some(s => s.id === 'i5' && /email/.test(s.reason)));
  });

  await test('never picks up a different area by accident', () => {
    const { willSend } = selectRecipients(LIST, 'SO');
    assert.ok(!willSend.some(r => r.id === 'i3'), 'Cara is in TA, not SO');
  });

  // ---- content ---------------------------------------------------------
  await test('names the area and links to pricing', () => {
    const b = buildAreaEmail(LIST[0], 'SO');
    assert.match(b.subject, /We now cover SO/);
    assert.ok(b.text.includes('https://solarmot.co.uk/pricing'));
  });

  await test('honours the promise: explains why they got it and offers removal', () => {
    const b = buildAreaEmail(LIST[0], 'SO');
    assert.match(b.text, /because you asked to be told/i);
    assert.match(b.text, /no thanks/i, 'must offer an easy way out');
  });

  await test('carries no offers or newsletter content', () => {
    const b = buildAreaEmail(LIST[0], 'SO');
    assert.ok(!/discount|offer|newsletter|unsubscribe from all/i.test(b.text),
      'the acknowledgement promised nothing but this');
  });

  await test('escapes a hostile name', () => {
    const b = buildAreaEmail({ name: '<img src=x onerror=1>', email: 'x@y.test' }, 'SO');
    assert.ok(!b.html.includes('<img src=x'));
  });

  // ---- sending ---------------------------------------------------------
  await test('emails everyone waiting in the area, and nobody else', async () => {
    reset();
    const { store, written } = makeStore();
    const r = await notifyArea({ store, apiKey: 'k' }, LIST, 'SO');

    assert.strictEqual(r.sent.length, 2, 'Ann and Bob');
    const to = sent.map(s => s.to[0]).sort();
    assert.deepStrictEqual(to, ['a@e.test', 'b@e.test']);
    assert.ok(!to.includes('c@e.test'), 'TA must not be emailed');
    assert.ok(!to.includes('d@e.test'), 'already-notified must not be emailed');
    assert.strictEqual(written.size, 2);
  });

  await test('marks each person as notified, with the area', async () => {
    reset();
    const { store, written } = makeStore();
    await notifyArea({ store, apiKey: 'k' }, LIST, 'SO');
    const rec = written.get('i1');
    assert.ok(rec.notifiedAt, 'must record when');
    assert.strictEqual(rec.notifiedForArea, 'SO', 'and for which area');
  });

  await test('running it again emails NOBODY — the core safety property', async () => {
    reset();
    const { store, written } = makeStore();
    await notifyArea({ store, apiKey: 'k' }, LIST, 'SO');

    // Feed the updated records back in, as a real re-run would see them.
    const updated = LIST.map(r => written.get(r.id) || r);
    reset();
    const second = await notifyArea({ store, apiKey: 'k' }, updated, 'SO');

    assert.strictEqual(second.sent.length, 0, 'a re-run must not re-email anyone');
    assert.strictEqual(sent.length, 0, 'and must not call the mail API at all');
  });

  await test('a failed send is reported and that person stays un-notified for a retry', async () => {
    reset();
    failFor = new Set(['a@e.test']);
    const { store, written } = makeStore();
    const r = await notifyArea({ store, apiKey: 'k' }, LIST, 'SO');

    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].email, 'a@e.test');
    assert.ok(!written.has('i1'), 'must NOT be marked notified, so a retry picks them up');
    assert.ok(written.has('i2'), 'the others still went');
  });

  await test('emailed-but-unrecorded is reported as a failure, not a success', async () => {
    reset();
    const { store } = makeStore({ failWrites: new Set(['i1']) });
    const r = await notifyArea({ store, apiKey: 'k' }, LIST, 'SO');

    assert.ok(r.failed.some(f => f.id === 'i1' && /may email them twice/.test(f.reason)),
      'the one genuinely dangerous case must be flagged loudly');
    assert.ok(!r.sent.some(s => s.id === 'i1'));
  });

  await test('an area with nobody waiting sends nothing', async () => {
    reset();
    const { store } = makeStore();
    const r = await notifyArea({ store, apiKey: 'k' }, LIST, 'ZZ');
    assert.strictEqual(r.sent.length, 0);
    assert.strictEqual(sent.length, 0);
  });

  real(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
