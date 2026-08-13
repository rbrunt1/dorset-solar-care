/**
 * The customer journey matches the offer that actually works.
 *
 * The site spent a while funnelling every visitor at a Direct Debit sign-up
 * that could not complete (no GoCardless token), while /reserve — the only
 * flow that runs end to end — had NO inbound links at all. Anyone arriving
 * would have hit a dead end, and the deposit strategy was invisible.
 *
 * These tests fail if that drifts back.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const publicPages = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html') && f !== 'admin.html');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

test('/reserve is reachable from every public page', () => {
  const orphaned = publicPages.filter(f => !read(f).includes('href="reserve.html'));
  assert.deepStrictEqual(orphaned, [],
    'these pages give the visitor no route to the reservation — that is how /reserve ended up orphaned');
});

test('no page sends people into the Direct Debit sign-up as a primary action', () => {
  const offenders = [];
  for (const f of publicPages) {
    if (f === 'signup.html') continue;
    if (/href="signup\.html[^"]*"[^>]*class="btn/.test(read(f))) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [], 'a button still leads to a flow that cannot complete');
});

test('the pricing cards lead to the reservation, carrying the chosen plan', () => {
  const p = read('pricing.html');
  for (const plan of ['essential', 'standard', 'premium']) {
    assert.ok(p.includes(`href="reserve.html?plan=${plan}"`), `${plan} card does not reach /reserve`);
  }
});

test('the reservation page honours the plan it was sent', () => {
  const r = read('reserve.html');
  assert.match(r, /preselectPlan/, 'the plan chosen on pricing would be silently dropped');
  assert.match(r, /URLSearchParams/);
});

test('someone returning from an abandoned payment is told their details are saved', () => {
  const r = read('reserve.html');
  assert.match(r, /checkout-cancelled/);
  assert.match(r, /details are\s+saved/i, 'otherwise they assume it all failed');
});

test('no page claims Direct Debit is how you pay right now', () => {
  const offenders = publicPages.filter(f => {
    const s = read(f);
    if (f === 'signup.html' || f === 'terms.html' || f === 'privacy.html') return false;
    return /Direct Debit powered by GoCardless/.test(s);
  });
  assert.deepStrictEqual(offenders, [], 'the footer still presents DD as the live payment method');
});

test('the sign-up page says plainly that it is not open, and stays out of search', () => {
  const s = read('signup.html');
  assert.match(s, /isn&rsquo;t open yet|is not open yet/i, 'no warning before a three-minute dead end');
  assert.match(s, /name="robots" content="noindex/, 'a dead-end page should not collect search traffic');
  assert.strictEqual((s.match(/name="robots"/g) || []).length, 1, 'duplicate robots tags');
});

test('the homepage no longer invites a sign-up that cannot happen', () => {
  const s = read('index.html');
  assert.ok(!/sign up/i.test(s), 'homepage still says "sign up"');
  assert.ok(!/Set up Direct Debit/i.test(s));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
