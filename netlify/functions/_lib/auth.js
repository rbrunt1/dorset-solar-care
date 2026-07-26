// Shared auth for the admin endpoints.
//
// Design notes, because the failure modes here matter more than the code:
//
//  1. It FAILS CLOSED. If ADMIN_TOKEN is not set in the environment, every
//     admin request is refused. The tempting alternative — "no token
//     configured, so allow everything" — would silently expose every
//     customer's name, address and phone number the moment the variable was
//     missing or mistyped. An admin page that stops working is a nuisance; one
//     that quietly opens is a data breach.
//
//  2. Comparison is constant-time. A plain === leaks the token a character at
//     a time to anyone patient enough to measure response times.
//
//  3. A short minimum length is enforced so a token like "admin" can't be set.
//
//  4. BOTH sides are trimmed. The supplied value was always trimmed, but the
//     configured one wasn't — so pasting a token into Netlify with a trailing
//     newline (which is exactly what `openssl ... | pbcopy` and most copy
//     actions produce) created a token that could never match anything a human
//     typed, with no way to tell from the outside. Nobody intends leading or
//     trailing whitespace in a password, so trimming both is safe and removes
//     an entire class of unexplainable login failure.

const crypto = require('node:crypto');

const MIN_TOKEN_LENGTH = 16;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, which itself leaks length.
  // Hashing first gives equal-length inputs and hides it.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function checkAdminAuth(event) {
  const expected = (process.env.ADMIN_TOKEN || '').trim();

  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    console.error('[admin] ADMIN_TOKEN is not set (or is too short) — refusing all admin access.');
    return {
      ok: false,
      status: 503,
      error: 'Admin access is not configured. Set a strong ADMIN_TOKEN (16+ characters) '
           + 'in Netlify environment variables.'
    };
  }

  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const supplied = header.replace(/^Bearer\s+/i, '').trim();

  if (!supplied || !timingSafeEqual(supplied, expected)) {
    // Log lengths, never values. A length mismatch points at a copy/paste
    // problem; equal lengths that still fail point at a genuinely wrong token.
    console.warn(
      `[admin] rejected a sign-in. supplied length=${supplied.length}, ` +
      `configured length=${expected.length}.`
    );
    return { ok: false, status: 401, error: 'Unauthorised' };
  }
  return { ok: true };
}

module.exports = { checkAdminAuth, MIN_TOKEN_LENGTH };
