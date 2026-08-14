/**
 * Layout containers.
 *
 * /reserve and /reserve-confirmed shipped using `class="container container-narrow"`.
 * Neither class exists in styles.css — the site's container is `.wrap` / `.wrap-narrow`.
 * The result was a page with no max-width and no gutter: the h1 sat hard against
 * the left edge of the viewport and the form ran the full width of the monitor.
 *
 * Nothing caught it. The HTML was valid, every link resolved, the reservation
 * saved, Stripe charged the right amount, and all 254 tests passed. A typo in a
 * class name is invisible to every check that doesn't compare markup to CSS.
 * That is what this file does.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

/** Class selectors the stylesheet actually defines. */
const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]));

/** Every class attribute value used in a page. */
function classesIn(html) {
  const out = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].trim().split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

// Classes that are script hooks rather than styling: attached by JS at runtime,
// or used only as querySelector targets. Each one below is paired with the file
// that actually uses it, so an entry can't be added without justifying it.
//
//   js, show, is-open, active  — toggled by js/main.js
//   slot-hint                  — querySelector target in js/booking.js:50,
//                                styled by the .text-muted next to it
//
// Adding to this list should be a deliberate decision, not a way to silence a
// real failure. If a class is here purely to make the test pass, that's the bug.
const SCRIPT_HOOKS = new Set(['js', 'show', 'is-open', 'active', 'slot-hint']);

test('found the pages to check', () => {
  assert.ok(pages.length >= 10, `expected the full site, found ${pages.length} pages`);
});

test('EVERY CLASS USED IN THE HTML IS DEFINED IN THE CSS', () => {
  const missing = [];
  for (const page of pages) {
    for (const c of classesIn(read(page))) {
      if (!defined.has(c) && !SCRIPT_HOOKS.has(c)) missing.push(`${page}: .${c}`);
    }
  }
  assert.deepStrictEqual(missing, [],
    `used but never defined, so they style nothing:\n        ${missing.join('\n        ')}`);
});

test('every page sits inside a real container', () => {
  // No .wrap means no max-width and no gutter — content runs to the viewport
  // edge. That is the exact symptom /reserve had.
  const unwrapped = pages.filter(p => !/class="[^"]*\bwrap\b/.test(read(p)));
  assert.deepStrictEqual(unwrapped, [], `no .wrap container: ${unwrapped.join(', ')}`);
});

test('nothing uses the .container class that does not exist', () => {
  const offenders = pages.filter(p => /class="[^"]*\bcontainer\b/.test(read(p)));
  assert.deepStrictEqual(offenders, [],
    `.container is not in styles.css — use .wrap: ${offenders.join(', ')}`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
