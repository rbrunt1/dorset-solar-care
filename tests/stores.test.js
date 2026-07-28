/**
 * Store-name consistency.
 *
 * This exists because of a real bug: the admin page read a store called
 * 'interest' while register-interest.js wrote to 'interest-registrations'.
 * Nothing errored — the dashboard simply showed nothing, and the backup export
 * silently omitted every area registration. A whole category of leads was
 * invisible.
 *
 * Comparing the two lists by reading the actual source files means the next
 * mismatch fails a test rather than losing data quietly.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FN = path.join(__dirname, '..', 'netlify', 'functions');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// What each endpoint actually writes to.
const written = fs.readdirSync(FN)
  .filter(f => f.endsWith('.js'))
  .map(f => {
    const src = fs.readFileSync(path.join(FN, f), 'utf8');
    const m = src.match(/storeName:\s*'([^']+)'/);
    return m ? { file: f, store: m[1] } : null;
  })
  .filter(Boolean);

// What the admin page reads.
const adminSrc = fs.readFileSync(path.join(FN, 'admin-data.js'), 'utf8');
const listed = (adminSrc.match(/const LEAD_STORES = \[([^\]]+)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

test('found the form endpoints and the admin list', () => {
  assert.ok(written.length >= 4, `expected 4+ form endpoints, found ${written.length}`);
  assert.ok(listed.length >= 4, `expected 4+ stores listed, found ${listed.length}`);
});

test('EVERY store written by an endpoint is read by the admin page', () => {
  for (const { file, store } of written) {
    assert.ok(listed.includes(store),
      `${file} writes to '${store}', which the admin page never reads — ` +
      `those leads would be invisible and missing from backups`);
  }
});

test('the admin page lists no store that nothing writes to', () => {
  const stores = written.map(w => w.store);
  for (const name of listed) {
    assert.ok(stores.includes(name),
      `admin reads '${name}', but no endpoint writes to it — probably a typo`);
  }
});

test('area-interest registrations specifically are covered', () => {
  const reg = written.find(w => w.file === 'register-interest.js');
  assert.ok(reg, 'register-interest.js should declare a storeName');
  assert.ok(listed.includes(reg.store),
    `the admin page must read '${reg.store}'`);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
