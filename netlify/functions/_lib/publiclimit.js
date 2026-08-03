// Abuse limits for the PUBLIC form endpoints.
//
// Separate from _lib/ratelimit.js on purpose. That one guards a password: five
// wrong guesses is an attack, so it blocks hard and escalates. This one guards
// a contact form used by strangers, where being wrong means losing a customer.
// So the numbers are far more generous and the failure mode is different.
//
// Two distinct limits, because they stop two distinct attacks:
//
//  1. PER SOURCE IP — stops one machine flooding the store with junk records
//     and burning function invocations.
//
//  2. PER RECIPIENT ADDRESS — the important one. The customer acknowledgement
//     sends to whatever email address was typed into the form, unverified. With
//     no cap, anyone could loop against /api/submit-enquiry with a victim's
//     address and mailbomb them with genuine, DKIM-signed mail from this
//     domain. The submission is still accepted and stored; only the outbound
//     acknowledgement is suppressed once an address has had its quota. That
//     way a real person who submits twice still gets a lead recorded, and a
//     victim of abuse stops receiving mail.
//
// Fails OPEN on any storage error, exactly like the admin limiter: losing a
// genuine enquiry costs more than allowing some abuse through during an outage.

const IP_MAX_SUBMISSIONS = 20;          // per window, per IP
const IP_WINDOW_MS = 60 * 60 * 1000;    // 1 hour

const EMAIL_MAX_ACKS = 3;               // acknowledgements to one address
const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

const STORE = 'public-throttle';

function clientIp(event) {
  const h = event?.headers || {};
  const fwd = h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

/** Addresses are keyed case-insensitively — Bob@x and bob@x are one person. */
function emailKey(email) {
  return 'ack-' + String(email || '').trim().toLowerCase();
}

async function bump(store, key, windowMs) {
  const now = Date.now();
  const rec = await store.get(key, { type: 'json' });
  if (!rec || now - rec.first > windowMs) {
    await store.setJSON(key, { first: now, count: 1 });
    return 1;
  }
  const count = rec.count + 1;
  await store.setJSON(key, { first: rec.first, count });
  return count;
}

async function peek(store, key, windowMs) {
  const rec = await store.get(key, { type: 'json' });
  if (!rec) return 0;
  if (Date.now() - rec.first > windowMs) return 0;
  return rec.count;
}

/**
 * Should this submission be refused outright?
 * Only for sustained flooding from one address.
 */
async function checkSubmissionLimit(openStore, event) {
  try {
    const store = openStore(event, STORE);
    const key = `ip-${clientIp(event)}`;
    const count = await peek(store, key, IP_WINDOW_MS);
    if (count >= IP_MAX_SUBMISSIONS) {
      return { limited: true, retryAfterSec: Math.ceil(IP_WINDOW_MS / 1000) };
    }
    await bump(store, key, IP_WINDOW_MS);
    return { limited: false };
  } catch (err) {
    console.warn('[public-limit] unavailable, allowing through:', err.message);
    return { limited: false };
  }
}

/**
 * May we send an acknowledgement to this address right now?
 *
 * Returning false does NOT reject the submission — the lead is still stored and
 * the owner still notified. It only suppresses the outbound email, which is the
 * part that can be weaponised against a third party.
 */
async function mayAcknowledge(openStore, event, email) {
  try {
    const store = openStore(event, STORE);
    const key = emailKey(email);
    const count = await peek(store, key, EMAIL_WINDOW_MS);
    if (count >= EMAIL_MAX_ACKS) return { allowed: false, reason: 'address-quota-reached' };
    await bump(store, key, EMAIL_WINDOW_MS);
    return { allowed: true };
  } catch (err) {
    console.warn('[public-limit] ack check unavailable, allowing:', err.message);
    return { allowed: true };
  }
}

module.exports = {
  checkSubmissionLimit, mayAcknowledge, clientIp, emailKey,
  IP_MAX_SUBMISSIONS, IP_WINDOW_MS, EMAIL_MAX_ACKS, EMAIL_WINDOW_MS, STORE
};
