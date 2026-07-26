// Shared helper for persisting form submissions using Netlify Blobs.
// Netlify Blobs is a zero-setup key/value store scoped to this site — no
// external database needed for a v1 launch. Each submission is saved as a
// JSON blob keyed by a generated id, under a named "store" (one per form).
//
// IMPORTANT — why connectLambda() is here:
// These functions use the Lambda-compatible signature (`exports.handler =
// async (event) => ...`). In that mode Netlify does NOT auto-configure the
// Blobs environment, so calling getStore() on its own throws
// MissingBlobsEnvironmentError in production (it works fine under
// `netlify dev`, which is what makes this so easy to miss). Netlify injects
// the credentials as `event.blobs`, and connectLambda(event) reads them.
// It must be called inside the handler, immediately before getStore().
//
// See: https://docs.netlify.com/build/data-and-storage/netlify-blobs/
const { connectLambda, getStore } = require('@netlify/blobs');
const { sendLeadNotification } = require('./notify');

/**
 * Open a Blobs store from ANY function context.
 *
 * connectLambda(event) only works when Netlify has put credentials on
 * `event.blobs`, which it does for request-triggered functions. A SCHEDULED
 * function is invoked internally with a synthetic event ({ next_run }) that
 * carries no such credentials — so connectLambda is a no-op there and
 * getStore() throws MissingBlobsEnvironmentError.
 *
 * That failure would be invisible: the weekly digest would simply never
 * arrive, and nobody notices an email that doesn't turn up. So this falls back
 * to explicit credentials, and if neither route is available it throws a
 * message that says exactly what to configure rather than a bare library error.
 */
function openStore(event, name) {
  if (event && event.blobs) {
    connectLambda(event);
    return getStore(name);
  }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });

  throw new Error(
    'Netlify Blobs is unavailable in this context. Request-triggered functions get ' +
    'credentials on event.blobs; scheduled functions do not. Set NETLIFY_API_TOKEN ' +
    '(a Netlify personal access token) in the environment so scheduled functions can ' +
    'reach Blobs. SITE_ID is provided automatically.'
  );
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read every record in a store.
 *
 * Blobs has no query layer: listing gives keys, and each value is a separate
 * HTTP round-trip. Reading them one at a time in a loop meant N sequential
 * requests inside a 10-second function timeout — fine at 20 records, broken
 * somewhere in the hundreds.
 *
 * Two mitigations:
 *  - fetch in parallel batches, so N round-trips take roughly N/CONCURRENCY
 *    of the time;
 *  - cap the total and report truncation, so the dashboard degrades visibly
 *    instead of silently timing out and showing nothing.
 *
 * This buys headroom, it doesn't remove the ceiling. Past a few thousand
 * records the right answer is a real database, not a bigger batch size.
 */
const READ_CONCURRENCY = 20;
const DEFAULT_MAX_RECORDS = 1000;

async function readAll(store, { limit = DEFAULT_MAX_RECORDS, label = 'store' } = {}) {
  const { blobs } = await store.list();
  const keys = blobs.map(b => b.key);
  const truncated = keys.length > limit;
  const wanted = truncated ? keys.slice(0, limit) : keys;

  if (truncated) {
    console.warn(`[${label}] ${keys.length} records exceeds the ${limit} cap; returning the first ${limit}.`);
  }

  const out = [];
  for (let i = 0; i < wanted.length; i += READ_CONCURRENCY) {
    const slice = wanted.slice(i, i + READ_CONCURRENCY);
    const values = await Promise.all(slice.map(async (key) => {
      try {
        return { key, value: await store.get(key, { type: 'json' }) };
      } catch (err) {
        // One unreadable record must not blank the whole dashboard.
        console.error(`[${label}] could not read ${key}:`, err.message);
        return null;
      }
    }));
    for (const r of values) if (r && r.value) out.push({ key: r.key, value: r.value });
  }

  return { records: out, total: keys.length, truncated };
}

/**
 * Persist one form submission.
 *
 * @param {object} event      the raw Lambda event — required, carries the
 *                            Blobs credentials Netlify injects
 * @param {string} storeName  logical store, one per form type
 * @param {string} prefix     id prefix, for readability when listing blobs
 * @param {object} payload    the validated submission fields
 * @returns {Promise<object>} the stored record
 */
async function saveSubmission(event, storeName, prefix, payload) {
  const id = newId(prefix);
  const record = { id, receivedAt: new Date().toISOString(), ...payload };

  // Log the submission before attempting to store it. If the blob write
  // fails for any reason, the lead is still recoverable from the function
  // logs in the Netlify dashboard rather than lost outright.
  console.log(`[${storeName}] received submission`, JSON.stringify(record));

  connectLambda(event);
  const store = getStore(storeName);
  await store.setJSON(id, record);

  console.log(`[${storeName}] stored ${id}`);
  return record;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/**
 * Shared wrapper for the form-handling functions: enforces POST, parses and
 * validates JSON, stores the submission, and maps failures onto honest status
 * codes. Crucially a storage failure returns 500 — never a 200 — so the
 * front end can tell the visitor their message didn't get through instead of
 * showing a success screen for a lead that was never saved.
 *
 * @param {object}   event
 * @param {object}   opts
 * @param {string}   opts.storeName
 * @param {string}   opts.prefix
 * @param {string[]} opts.required  field names that must be present
 * @param {(data: object) => object} opts.build  maps raw body -> stored fields
 */
async function handleSubmission(event, { storeName, prefix, required = [], build }) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  // Bot checks, before anything is stored or emailed.
  //
  // Answers 200 with a fake success rather than an error. This is intentional:
  // telling a spam bot precisely why it was rejected is telling its author how
  // to fix it. A silent discard makes the campaign look like it worked, and the
  // operator moves on. Nothing is written and nothing is emailed.
  const spam = looksAutomated(data);
  if (spam) {
    console.warn(`[${storeName}] discarded a likely automated submission: ${spam}`);
    return jsonResponse(200, { ok: true, id: 'discarded' });
  }

  // Structural check, reported loudly on purpose — see cameFromRenderedForm.
  if (!cameFromRenderedForm(data)) {
    console.warn(`[${storeName}] rejected a submission with no evidence of the rendered form.`);
    return jsonResponse(400, {
      error: 'This submission did not come from the website form. '
           + 'Please reload the page and try again.'
    });
  }

  const missing = required.filter(f => {
    const v = data[f];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    return jsonResponse(400, {
      error: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    });
  }

  // Attribution is captured once here rather than in each build() so every
  // form gets it automatically and none can silently forget it. It is stored
  // separately from the customer's own fields so it can never collide with
  // one, and it is deliberately NOT part of `required` — a missing source
  // must never block a real lead.
  const fields = { ...build(data), source: cleanSource(data.source) };
  // The trap fields are plumbing, not customer data. Drop them so they never
  // appear in a stored record, an export, or a notification email.
  delete fields[HONEYPOT_FIELD];
  delete fields._fillMs;

  let record;
  try {
    record = await saveSubmission(event, storeName, prefix, fields);
  } catch (err) {
    // Log loudly — this is the path where a real enquiry could be lost.
    console.error(`[${storeName}] FAILED to store submission:`, err);
    return jsonResponse(500, {
      error: 'Could not store submission',
      detail: String(err && err.message ? err.message : err)
    });
  }

  // Notify after the record is safely stored. sendLeadNotification never
  // throws, and we deliberately don't let its result affect the response:
  // the lead IS saved, so the visitor must see success even if the email
  // fails. A failed send is logged for someone to pick up.
  const notified = await sendLeadNotification(storeName, record, siteUrl());

  return jsonResponse(200, { ok: true, id: record.id, notified: notified.sent === true });
}

/**
 * Does this submission look automated?
 *
 * Returns a reason string when it does, or null when it looks human. Kept
 * separate and pure so the thresholds are testable without HTTP.
 *
 * The honeypot is the strong signal: a field hidden off-screen, unlabelled to
 * anyone reading the page, that no human can see or tab into. Anything in it is
 * a script filling every input it finds.
 *
 * The timing floor is 2.5 seconds. The shortest form that reaches this code has
 * four fields, so even a visitor using browser autofill and submitting straight
 * away takes longer than that. It is deliberately not higher: past roughly three
 * seconds you start gambling with fast, autofilling, genuinely interested people,
 * and a bot author who bothers to add a delay defeats any threshold anyway.
 *
 * The third check is the structural one and the strongest of the three: did this
 * request come from a rendered page at all? Every form on the site is in the
 * static HTML and every POST path attaches the trap fields, so a real submission
 * always carries the honeypot key — empty, but present. A request without it
 * never loaded the page, which is exactly how spam reaches a JSON endpoint.
 * (Safe to rely on because main.js is served `max-age=0, must-revalidate`, so
 * there is no window where a visitor holds an older script.)
 *
 * Note the asymmetry in how failures are reported, in `handleSubmission`:
 * confirmed-bot signals are discarded silently, but a missing honeypot key
 * returns a visible 400. If a future change ever breaks a real submission path,
 * somebody sees an error and says so — rather than enquiries vanishing quietly,
 * which is the worst possible failure for this business.
 */
const HONEYPOT_FIELD = '_hp_website';
const MIN_FILL_MS = 2500;

function looksAutomated(data) {
  if (!data || typeof data !== 'object') return null;

  const hp = data[HONEYPOT_FIELD];
  if (typeof hp === 'string' && hp.trim() !== '') return 'honeypot field was filled';

  const fill = data._fillMs;
  if (typeof fill === 'number' && Number.isFinite(fill) && fill >= 0 && fill < MIN_FILL_MS) {
    return `submitted in ${fill}ms, under the ${MIN_FILL_MS}ms floor`;
  }

  return null;
}

/**
 * Did this request come from a page that actually rendered the form?
 * Separate from looksAutomated() because it is reported differently — visibly,
 * not silently. See the note above.
 */
function cameFromRenderedForm(data) {
  return !!data && typeof data === 'object'
      && Object.prototype.hasOwnProperty.call(data, HONEYPOT_FIELD);
}

/** Best guess at the public site URL, for context inside notification emails. */
function siteUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://solarmot.co.uk';
}

/**
 * Sanitise the attribution object sent by the browser.
 *
 * This is untrusted input that goes straight into a stored record and a
 * notification email, so it is whitelisted to known keys, coerced to strings
 * and length-capped. Anything unexpected is dropped rather than stored.
 * Returns null when there's nothing useful, so empty objects don't clutter
 * the record.
 */
const SOURCE_KEYS = ['referrer', 'landingPage', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'firstSeen'];
const MAX_SOURCE_LEN = 500;

function cleanSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of SOURCE_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim().slice(0, MAX_SOURCE_LEN);
    if (s) out[key] = s;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  saveSubmission, jsonResponse, handleSubmission, cleanSource, openStore, readAll,
  looksAutomated, cameFromRenderedForm, HONEYPOT_FIELD, MIN_FILL_MS
};
