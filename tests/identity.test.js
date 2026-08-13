/**
 * Trading identity.
 *
 * Every page footer used to read "SolarMOT Ltd. Registered in England & Wales."
 * There is no such company on the Companies House register, so that was a false
 * statement about the trader's identity on a site about to take deposits —
 * a misleading action under the Consumer Protection from Unfair Trading
 * Regulations 2008, and a straightforward way to lose a Stripe account.
 *
 * These tests won't let it come back, and won't let the unfinished placeholders
 * quietly become permanent either.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

test('found the pages to check', () => {
  assert.ok(pages.length >= 10, `expected the full site, found ${pages.length} pages`);
});

// The legal pages legitimately mention the name in order to warn that it is NOT
// registered. Strip those sentences before looking for actual claims, or the
// warning itself trips the test.
const claimsOnly = (f) => read(f)
  .replace(/There is no company called[^.]*\./gi, '')
  .replace(/no company called[^.]*\./gi, '');

test('NO page claims to be a registered company that does not exist', () => {
  const offenders = pages.filter(f => /SolarMOT Ltd/i.test(claimsOnly(f)));
  assert.deepStrictEqual(offenders, [],
    'these pages name "SolarMOT Ltd", which is not on the Companies House register');
});

test('no page claims company registration at all until one exists', () => {
  const offenders = pages.filter(f =>
    /registered in england|limited company|ltd company|registered UK Ltd/i.test(claimsOnly(f)));
  assert.deepStrictEqual(offenders, [], 'unsubstantiated registration claim');
});

test('the old placeholders are gone rather than sitting in live copy', () => {
  const offenders = pages.filter(f => /\[COMPANY NUMBER\]|\[REGISTERED ADDRESS\]/.test(read(f)));
  assert.deepStrictEqual(offenders, []);
});

test('terms still names a trader slot, and flags it as unfinished', () => {
  const t = read('terms.html');
  assert.match(t, /legal-todo/, 'the trader slot must be visibly unfinished');
  assert.match(t, /TRADING ENTITY/i);
  assert.match(t, /do not take payment/i, 'the warning must be unmissable');
});

test('privacy still names a controller slot, and flags it as unfinished', () => {
  const p = read('privacy.html');
  assert.match(p, /legal-todo/);
  assert.match(p, /DATA CONTROLLER/i);
});

test('an unfinished placeholder is styled so it cannot pass for finished copy', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.legal-todo\s*\{/, 'legal-todo has no styling, so it would read as body text');
});

test('the footer still carries the MCS and "MOT" disclaimers', () => {
  // Removing the false company claim must not have taken the honest ones with it.
  for (const f of pages) {
    const s = read(f);
    if (!s.includes('site-footer')) continue;
    assert.match(s, /not an MCS-certified installer/i, `${f} lost the MCS disclaimer`);
    assert.match(s, /does not refer to any statutory test/i, `${f} lost the MOT disclaimer`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
