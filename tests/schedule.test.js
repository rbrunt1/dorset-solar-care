/**
 * Visit-scheduling and admin-auth tests.
 *
 * The scheduling maths is pure, so it's tested directly. The auth is tested
 * for the case that actually matters: what happens when ADMIN_TOKEN is absent.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const S = require(path.join(__dirname, '..', 'netlify', 'functions', '_lib', 'schedule.js'));
const { checkAdminAuth } = require(path.join(__dirname, '..', 'netlify', 'functions', '_lib', 'auth.js'));

const d = (iso) => new Date(`${iso}T00:00:00Z`);

// ---- month arithmetic ------------------------------------------------------

test('adding a month to the 31st clamps to the end of a short month', () => {
  // Naive JS date maths rolls 31 Jan + 1 month into 2 or 3 March. Every
  // schedule starting on a 29th/30th/31st would drift forward every cycle.
  assert.strictEqual(S.toISODate(S.addMonths(d('2026-01-31'), 1)), '2026-02-28');
  assert.strictEqual(S.toISODate(S.addMonths(d('2028-01-31'), 1)), '2028-02-29'); // leap year
  assert.strictEqual(S.toISODate(S.addMonths(d('2026-03-31'), 1)), '2026-04-30');
});

test('adding months crosses year boundaries correctly', () => {
  assert.strictEqual(S.toISODate(S.addMonths(d('2026-08-15'), 6)), '2027-02-15');
  assert.strictEqual(S.toISODate(S.addMonths(d('2026-07-25'), 12)), '2027-07-25');
});

// ---- cadence ---------------------------------------------------------------

test('next due follows the plan cadence from the last visit', () => {
  assert.strictEqual(S.nextDueDate({ plan: 'essential', startDate: '2026-01-10', lastVisit: '2026-03-01' }), '2027-03-01');
  assert.strictEqual(S.nextDueDate({ plan: 'standard',  startDate: '2026-01-10', lastVisit: '2026-03-01' }), '2026-09-01');
  assert.strictEqual(S.nextDueDate({ plan: 'premium',   startDate: '2026-01-10', lastVisit: '2026-03-01' }), '2026-09-01');
});

test('a customer who has never been visited is due at their start date', () => {
  // Not "a cadence after signing up" — they've paid and had nothing yet.
  assert.strictEqual(S.nextDueDate({ plan: 'standard', startDate: '2026-07-25' }), '2026-07-25');
});

test('an unknown plan falls back to annual instead of throwing', () => {
  // A bad plan value must not silently drop someone off the work list.
  assert.strictEqual(S.nextDueDate({ plan: 'gold', startDate: '2026-01-01', lastVisit: '2026-01-01' }), '2027-01-01');
});

// ---- status ----------------------------------------------------------------

test('overdue, due-soon and scheduled are classified correctly', () => {
  const today = d('2026-07-25');
  const mk = (nextDue) => S.withSchedule({ plan: 'standard', startDate: '2026-01-01', nextDue }, today);
  assert.strictEqual(mk('2026-07-01').scheduleStatus, 'overdue');
  assert.strictEqual(mk('2026-07-25').scheduleStatus, 'due-soon');
  assert.strictEqual(mk('2026-08-05').scheduleStatus, 'due-soon');
  assert.strictEqual(mk('2026-09-30').scheduleStatus, 'scheduled');
  assert.strictEqual(mk('2026-07-01').daysUntilDue, -24);
});

test('cancelled customers are never classified as due', () => {
  const c = S.withSchedule({ plan: 'standard', startDate: '2026-01-01', nextDue: '2026-01-01', status: 'cancelled' }, d('2026-07-25'));
  assert.strictEqual(c.scheduleStatus, 'cancelled');
});

// ---- the work list ---------------------------------------------------------

test('due list excludes cancelled and sorts most overdue first', () => {
  const today = d('2026-07-25');
  const list = S.dueList([
    { id: 'a', name: 'A', plan: 'standard', startDate: '2026-01-01', nextDue: '2026-08-01' },
    { id: 'b', name: 'B', plan: 'standard', startDate: '2026-01-01', nextDue: '2026-06-01' },
    { id: 'c', name: 'C', plan: 'standard', startDate: '2026-01-01', nextDue: '2026-07-01', status: 'cancelled' },
    { id: 'd', name: 'D', plan: 'standard', startDate: '2026-01-01', nextDue: '2027-01-01' }
  ], today);

  assert.deepStrictEqual(list.map(c => c.id), ['b', 'a'], 'B most overdue first; C cancelled; D beyond horizon');
});

// ---- completing a visit ----------------------------------------------------

test('completing a visit rolls the schedule forward and keeps history', () => {
  const before = { id: 'x', name: 'X', plan: 'standard', startDate: '2026-01-01', nextDue: '2026-01-01' };
  const after = S.completeVisit(before, d('2026-07-25'));
  assert.strictEqual(after.lastVisit, '2026-07-25');
  assert.strictEqual(after.nextDue, '2027-01-25', 'standard = 6 months on');
  assert.strictEqual(after.visitsCompleted, 1);
  assert.deepStrictEqual(after.visitHistory, ['2026-07-25']);

  const twice = S.completeVisit(after, d('2027-01-25'));
  assert.strictEqual(twice.visitsCompleted, 2);
  assert.deepStrictEqual(twice.visitHistory, ['2026-07-25', '2027-01-25']);
});

// ---- admin auth ------------------------------------------------------------

test('admin access FAILS CLOSED when ADMIN_TOKEN is not set', () => {
  // The dangerous alternative is "no token configured, so allow everything",
  // which would expose every customer record on a missing env var.
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  const r = checkAdminAuth({ headers: { authorization: 'Bearer anything' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 503);
  if (saved !== undefined) process.env.ADMIN_TOKEN = saved;
});

test('a short ADMIN_TOKEN is refused rather than accepted', () => {
  const saved = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'admin';
  const r = checkAdminAuth({ headers: { authorization: 'Bearer admin' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 503);
  if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved;
});

test('a wrong token is rejected and a correct one accepted', () => {
  const saved = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'a-sufficiently-long-test-token';
  assert.strictEqual(checkAdminAuth({ headers: {} }).ok, false);
  assert.strictEqual(checkAdminAuth({ headers: { authorization: 'Bearer wrong-token-here-abc' } }).ok, false);
  assert.strictEqual(checkAdminAuth({ headers: { authorization: 'Bearer a-sufficiently-long-test-token' } }).ok, true);
  // header name casing varies between platforms
  assert.strictEqual(checkAdminAuth({ headers: { Authorization: 'Bearer a-sufficiently-long-test-token' } }).ok, true);
  if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved;
});
