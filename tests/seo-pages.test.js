/**
 * Town pages and the cornerstone article.
 *
 * The specific way location pages fail is by being near-identical to each other
 * with the town name swapped in. Google treats that as doorway content and
 * filters it, so the most important test here is the SIMILARITY one: if any two
 * town pages share too much of their body text, they stop being useful.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TOWNS = ['poole', 'bournemouth', 'christchurch', 'weymouth', 'dorchester', 'wimborne'];
const pages = TOWNS.map(t => `solar-panel-cleaning-${t}.html`);
const ARTICLE = 'how-often-should-solar-panels-be-cleaned.html';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

/** Body text only — strip head, scripts, tags, and the shared nav/footer chrome. */
function bodyText(f) {
  let s = read(f);
  s = s.slice(s.indexOf('<body>'));
  s = s.replace(/<script[\s\S]*?<\/script>/g, '')
       .replace(/<header[\s\S]*?<\/header>/g, '')
       .replace(/<footer[\s\S]*?<\/footer>/g, '')
       .replace(/<[^>]+>/g, ' ')
       .replace(/&[a-z]+;/g, ' ')
       .replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

test('all six town pages and the article exist', () => {
  for (const f of [...pages, ARTICLE]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} missing`);
  }
});

test('every page has a unique title, description and canonical', () => {
  const seen = { title: new Set(), desc: new Set(), canon: new Set() };
  for (const f of [...pages, ARTICLE]) {
    const s = read(f);
    const title = (s.match(/<title>(.*?)<\/title>/) || [])[1];
    const desc = (s.match(/name="description" content="(.*?)"/) || [])[1];
    const canon = (s.match(/rel="canonical" href="(.*?)"/) || [])[1];
    for (const [k, v] of [['title', title], ['desc', desc], ['canon', canon]]) {
      assert.ok(v, `${f} has no ${k}`);
      assert.ok(!seen[k].has(v), `${f} duplicates another page's ${k}`);
      seen[k].add(v);
    }
  }
});

test('titles stay within the length Google will display', () => {
  for (const f of [...pages, ARTICLE]) {
    const t = (read(f).match(/<title>(.*?)<\/title>/) || [])[1];
    assert.ok(t.length <= 62, `${f}: title is ${t.length} chars — "${t}"`);
  }
});

test('NO TWO TOWN PAGES ARE NEAR-DUPLICATES', () => {
  // Jaccard similarity on word sets. Shared boilerplate ("what a visit covers")
  // is expected; the local sections must pull them apart.
  const sets = pages.map(f => new Set(bodyText(f).split(' ').filter(w => w.length > 3)));
  const worst = { pair: null, sim: 0 };
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const inter = [...sets[i]].filter(w => sets[j].has(w)).length;
      const union = new Set([...sets[i], ...sets[j]]).size;
      const sim = inter / union;
      if (sim > worst.sim) { worst.sim = sim; worst.pair = `${pages[i]} vs ${pages[j]}`; }
    }
  }
  assert.ok(worst.sim < 0.62,
    `${worst.pair} are ${(worst.sim * 100).toFixed(0)}% similar — that reads as doorway content`);
  console.log(`        (most similar pair: ${worst.pair} at ${(worst.sim * 100).toFixed(0)}%)`);
});

test('each town page names its own postcodes and neighbourhoods', () => {
  const marks = {
    poole: ['sandbanks', 'harbour', 'bh13'],
    bournemouth: ['pine', 'resin', 'bh1'],
    christchurch: ['stour', 'mudeford', 'bh23'],
    weymouth: ['portland', 'dt4', 'channel'],
    dorchester: ['poundbury', 'harvest', 'dt1'],
    wimborne: ['colehill', 'lichen', 'bh21'],
  };
  for (const t of TOWNS) {
    const body = bodyText(`solar-panel-cleaning-${t}.html`);
    for (const m of marks[t]) {
      assert.ok(body.includes(m), `${t} page never mentions "${m}"`);
    }
  }
});

test('every town page is reachable from the service-area hub', () => {
  const hub = read('service-area.html');
  for (const t of TOWNS) {
    assert.ok(hub.includes(`solar-panel-cleaning-${t}.html`), `hub does not link to ${t}`);
  }
});

test('town pages link to the article, and the article links back to every town', () => {
  for (const t of TOWNS) {
    assert.ok(read(`solar-panel-cleaning-${t}.html`).includes(ARTICLE),
      `${t} page does not link to the guide`);
  }
  const a = read(ARTICLE);
  for (const t of TOWNS) {
    assert.ok(a.includes(`solar-panel-cleaning-${t}.html`), `article does not link to ${t}`);
  }
});

test('every new page routes to the reservation', () => {
  for (const f of [...pages, ARTICLE]) {
    assert.ok(read(f).includes('href="reserve.html'), `${f} has no route to /reserve`);
  }
});

test('the JSON-LD on every new page parses and declares the right types', () => {
  for (const f of [...pages, ARTICLE]) {
    const blocks = read(f).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    assert.ok(blocks.length, `${f} has no structured data`);
    for (const b of blocks) {
      const json = b.replace(/<\/?script[^>]*>/g, '');
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(json); }, `${f}: invalid JSON-LD`);
      const types = JSON.stringify(parsed);
      assert.ok(types.includes('BreadcrumbList'), `${f}: no breadcrumbs`);
    }
  }
  assert.ok(read(ARTICLE).includes('"FAQPage"'), 'article has no FAQ schema');
  assert.ok(read('solar-panel-cleaning-poole.html').includes('"Service"'), 'town page has no Service schema');
});

test('new pages carry no unverified insurance or company claims', () => {
  for (const f of [...pages, ARTICLE]) {
    const s = read(f);
    assert.ok(!/SolarMOT Ltd|registered in england|fully insured/i.test(s),
      `${f} reintroduces a claim we cannot stand behind`);
  }
});

test('the article does not assert a single confident soiling percentage', () => {
  const a = bodyText(ARTICLE);
  assert.ok(a.includes('treat any confident single number'),
    'the honesty caveat about percentages has gone');
  assert.ok(!/up to 30%|up to 25%|lose 30%/.test(a), 'reintroduced an unsupportable headline figure');
});

test('every new page is in the sitemap', () => {
  const sm = read('sitemap.xml');
  for (const f of [...pages, ARTICLE]) {
    assert.ok(sm.includes(f.replace('.html', '')), `${f} missing from sitemap`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
