/**
 * Deposit reporting.
 *
 * Charging a deposit only tells you anything if the dashboard distinguishes
 * "said they were interested" from "actually paid". These tests pin that down,
 * plus the money formatting — a figure shown as 2500 instead of £25 is worse
 * than showing nothing, because it invites a wrong decision.
 *
 * They also check the admin page's own column count, because a row with more
 * cells than the header silently shifts every column and nobody notices until
 * they read the wrong number off the wrong column.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const adminJs = fs.readFileSync(path.join(ROOT, 'js', 'admin.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const adminFn = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'admin-data.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// Pull the two pure helpers out of admin.js without a DOM.
const money = new Function(`${adminJs.match(/function money\(pence\)[\s\S]*?\n}/)[0]}; return money;`)();

// ---- money ---------------------------------------------------------------
test('shows whole pounds without stray decimals', () => {
  assert.strictEqual(money(2500), '£25');
  assert.strictEqual(money(0), '£0');
});

test('shows pence when there are pence', () => {
  assert.strictEqual(money(2550), '£25.50');
  assert.strictEqual(money(1999), '£19.99');
});

test('never renders a raw pence figure that could be misread as pounds', () => {
  for (const p of [2500, 1999, 100000]) {
    assert.ok(money(p).startsWith('£'), `${p} should be formatted as currency`);
  }
});

test('a missing or junk amount reads as £0, not NaN', () => {
  assert.strictEqual(money(undefined), '£0');
  assert.strictEqual(money(null), '£0');
  assert.strictEqual(money('nonsense'), '£0');
});

// ---- the invisible-store class of bug ------------------------------------
test('reservations are in LEAD_STORES, so they appear at all', () => {
  const listed = (adminFn.match(/const LEAD_STORES = \[([^\]]+)\]/) || [, ''])[1];
  assert.ok(listed.includes("'reservations'"),
    'without this, every reservation is invisible in the dashboard and absent from backups');
});

test('the deposit counts are actually computed and returned', () => {
  for (const key of ['depositsPaid', 'depositsPence', 'depositsPending', 'reservations:']) {
    assert.ok(adminFn.includes(key), `admin-data.js should report ${key}`);
  }
});

test('paid is decided by depositStatus, never by the browser redirect', () => {
  assert.match(adminFn, /depositStatus === 'paid'/,
    'the count must read the stored status, which only the signed webhook sets');
});

// ---- the table lines up --------------------------------------------------
test('the leads table body has exactly as many cells as the header', () => {
  const header = adminHtml.match(/<thead><tr>(.*?)<\/tr><\/thead>/g)
    .map(h => (h.match(/<th>/g) || []).length);
  const leadHeader = header[1];              // second table on the page is Leads
  const rowFn = adminJs.match(/function renderLeads[\s\S]*?\n}/)[0];
  const cells = (rowFn.match(/<td[ >]/g) || []).length;
  assert.strictEqual(cells, leadHeader,
    `header has ${leadHeader} columns but each row renders ${cells} cells — ` +
    'every column after the mismatch would show the wrong data');
});

test('the deposit column exists in both the header and the row', () => {
  assert.ok(adminHtml.includes('<th>Deposit</th>'), 'no Deposit header');
  assert.ok(adminJs.includes('depositCell(l)'), 'rows never render the deposit');
});

// ---- what the deposit cell says ------------------------------------------
const depositCell = new Function(
  'fmtDate', 'esc', 'money',
  `${adminJs.match(/function depositCell\(l\)[\s\S]*?\n}/)[0]}; return depositCell;`
)(v => String(v || '—'), v => String(v), money);

test('a paid deposit shows the amount, not just a tick', () => {
  const out = depositCell({ _store: 'reservations', depositStatus: 'paid', depositAmount: 2500, paidAt: '2026-08-12' });
  assert.match(out, /£25/);
  assert.match(out, /paid/i);
});

test('someone who left at the card screen is called out, not shown as blank', () => {
  const out = depositCell({ _store: 'reservations', depositStatus: 'pending', checkoutStartedAt: '2026-08-12' });
  assert.match(out, /card screen/i, 'these are the warmest leads on the page');
});

test('a reservation that never reached checkout is distinguishable from one that did', () => {
  const notStarted = depositCell({ _store: 'reservations', depositStatus: 'pending' });
  const abandoned = depositCell({ _store: 'reservations', depositStatus: 'pending', checkoutStartedAt: 'x' });
  assert.notStrictEqual(notStarted, abandoned);
});

test('non-reservation leads show nothing rather than a misleading "unpaid"', () => {
  for (const store of ['enquiries', 'bookings', 'commercial-quotes', 'interest-registrations']) {
    const out = depositCell({ _store: store });
    assert.ok(!/paid/i.test(out), `${store} should not mention payment at all`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
