// Consistent, greppable logging for the form endpoints.
//
// Two goals, and they pull against each other:
//
//  1. Every submission should leave a trail you can follow — did it arrive, was
//     it stored, was it emailed, and if not, why.
//  2. Netlify's function logs are NOT the place for customer personal data.
//     They're readable by anyone with dashboard access, they're outside the
//     Blobs store the privacy policy describes, and they're retained on
//     Netlify's schedule rather than yours. Routinely writing names, emails,
//     phone numbers and postcodes there creates a second copy of personal data
//     nobody is managing.
//
// So the happy path logs FACTS ABOUT the submission (which fields were present,
// where the lead came from) and never the values. Identifiers only.
//
// The one deliberate exception is a storage failure: at that moment the log is
// the ONLY remaining copy of a real customer's enquiry, so the full record is
// written out and clearly marked. Losing a lead entirely is worse than a
// personal record sitting in a log for 24 hours — but that trade is only worth
// making when something has actually gone wrong.
//
// Every line carries the Netlify request id so the lines belonging to one
// submission can be pulled together, which is what makes the logs usable at all
// once there is real traffic.

/** Netlify's per-request id, for correlating lines. '-' when absent (e.g. tests). */
function requestId(event) {
  const h = (event && event.headers) || {};
  return h['x-nf-request-id'] || h['X-Nf-Request-Id'] || '-';
}

/**
 * Describe a submission without revealing it.
 *
 * Returns something like `fields=name,email,postcode missing=phone chars=142`.
 * Enough to diagnose "the form is posting without an email address" without
 * putting the email address in a log file.
 */
function describe(data, { expected = [] } = {}) {
  if (!data || typeof data !== 'object') return 'body=none';

  const internal = new Set(['_hp_website', '_fillMs', 'source']);
  const present = Object.keys(data)
    .filter(k => !internal.has(k))
    .filter(k => data[k] !== undefined && data[k] !== null && String(data[k]).trim() !== '');

  const missing = expected.filter(k => !present.includes(k));
  const chars = Object.entries(data)
    .filter(([k]) => !internal.has(k))
    .reduce((n, [, v]) => n + String(v ?? '').length, 0);

  return [
    `fields=${present.join(',') || 'none'}`,
    missing.length ? `missing=${missing.join(',')}` : null,
    `chars=${chars}`
  ].filter(Boolean).join(' ');
}

/** Where the lead came from, in one short token. Never the full referrer URL. */
function describeSource(source) {
  if (!source || typeof source !== 'object') return 'source=none';
  if (source.utmSource || source.utmMedium) {
    return `source=${[source.utmSource, source.utmMedium].filter(Boolean).join('/')}`;
  }
  if (source.referrer && source.referrer !== 'direct') {
    try { return `source=${new URL(source.referrer).hostname}`; }
    catch { return 'source=referral'; }
  }
  if (source.referrer === 'direct') return 'source=direct';
  return 'source=none';
}

const line = (store, rid, event, rest = '') =>
  `[${store}] rid=${rid} ${event}${rest ? ' ' + rest : ''}`;

module.exports = { requestId, describe, describeSource, line };
