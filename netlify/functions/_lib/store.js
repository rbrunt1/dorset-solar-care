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

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  const missing = required.filter(f => {
    const v = data[f];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    return jsonResponse(400, {
      error: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    });
  }

  let record;
  try {
    record = await saveSubmission(event, storeName, prefix, build(data));
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

/** Best guess at the public site URL, for context inside notification emails. */
function siteUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://solarmot.co.uk';
}

module.exports = { saveSubmission, jsonResponse, handleSubmission };
