// Input size limits for the public form endpoints.
//
// Before this, no submitted field had any length cap: submit-enquiry.js copied
// data.message straight through, and only the attribution object was capped
// (MAX_SOURCE_LEN in store.js). A live probe confirmed 5 MB bodies reached the
// function and were parsed — with a valid `name` present, a 5 MB record would
// have been stored in Blobs and emailed.
//
// Two layers:
//
//  1. A whole-body cap, checked BEFORE JSON.parse. Parsing a huge string costs
//     memory and time, so the cheap check comes first.
//  2. Per-field caps applied after validation, so a submission that is merely
//     long is TRUNCATED and kept rather than rejected. That bias is deliberate:
//     a customer who writes a very long message should still reach you, just
//     trimmed. Only an absurd body — far beyond anything a person types — is
//     refused outright.
//
// The limits are generous on purpose. A UK postcode is at most 8 characters,
// but 20 costs nothing and avoids rejecting somebody who types oddly. The
// intent is to stop storage abuse, not to police how people fill in a form.

// ~64 KB. A very long enquiry is a few thousand characters; this is orders of
// magnitude above real use, and far below what an attacker needs to be
// effective at filling the store.
const MAX_BODY_BYTES = 64 * 1024;

const FIELD_LIMITS = {
  name: 120,
  contact: 120,
  company: 160,
  email: 254,          // RFC 5321 maximum path length
  phone: 32,
  postcode: 20,
  systemSize: 32,
  serviceLevel: 40,
  plan: 40,
  slot: 60,
  date: 40,
  coverageStatus: 20,
  message: 5000        // a genuinely long enquiry, with room to spare
};

const DEFAULT_FIELD_LIMIT = 500;

/** Byte length of the raw request body, not character count. */
function bodyBytes(body) {
  if (!body) return 0;
  return Buffer.byteLength(String(body), 'utf8');
}

function isOversized(body) {
  return bodyBytes(body) > MAX_BODY_BYTES;
}

/**
 * Trim every string field to its limit. Returns the object plus the names of
 * anything trimmed, so it can be logged — a customer whose message was cut off
 * is worth knowing about, since you may want the rest of it.
 */
function capFields(fields) {
  const out = {};
  const truncated = [];

  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value !== 'string') { out[key] = value; continue; }
    const limit = FIELD_LIMITS[key] ?? DEFAULT_FIELD_LIMIT;
    if (value.length > limit) {
      out[key] = value.slice(0, limit);
      truncated.push(`${key}(${value.length}>${limit})`);
    } else {
      out[key] = value;
    }
  }
  return { fields: out, truncated };
}

module.exports = { MAX_BODY_BYTES, FIELD_LIMITS, DEFAULT_FIELD_LIMIT, bodyBytes, isOversized, capFields };
