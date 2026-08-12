// Stripe helpers: Checkout Session creation and webhook verification.
//
// Two things about Stripe's API that are easy to get wrong and are the reason
// this file exists rather than inline fetch calls:
//
//  1. The REST API is FORM-ENCODED, not JSON, and nested parameters use a
//     bracket syntax (line_items[0][price_data][unit_amount]). Sending JSON
//     gets you a confusing 400.
//  2. Webhook signatures are computed over `${timestamp}.${rawBody}` — not the
//     body alone. Parsing and re-serialising the body changes the bytes and
//     breaks verification, so the raw string must be used.
//
// The deposit amount lives here as a server-side constant. It is never read
// from the request: a price sent by the browser is a price an attacker can
// change, and a £0.01 deposit would make the whole validation meaningless.

const crypto = require('node:crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

/** £25 by default, in pence. Overridable by env so it can change without a code edit. */
function depositPence() {
  const raw = parseInt(process.env.DEPOSIT_AMOUNT_PENCE || '2500', 10);
  // Guard against a mistyped env var silently charging £0 or something absurd.
  if (!Number.isFinite(raw) || raw < 100 || raw > 20000) return 2500;
  return raw;
}

/**
 * Flatten an object into Stripe's bracketed form-encoding.
 * { a: { b: 1 } } -> "a[b]=1"
 */
function formEncode(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      formEncode(value, k, out);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object') formEncode(v, `${k}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else {
      out.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
    }
  }
  return out.join('&');
}

/**
 * Create a Checkout Session for a reservation deposit.
 *
 * The reservation id goes into metadata so the webhook can find the record
 * again. Idempotency is keyed on it too, so a double-clicked button or a
 * retried request reuses the same session instead of creating a second one.
 */
async function createDepositSession({ reservation, siteUrl, apiKey }) {
  const amount = depositPence();
  const body = formEncode({
    mode: 'payment',
    customer_email: reservation.email,
    client_reference_id: reservation.id,
    success_url: `${siteUrl}/reserve-confirmed?ref=${encodeURIComponent(reservation.id)}`,
    cancel_url: `${siteUrl}/reserve?cancelled=1`,
    metadata: { reservationId: reservation.id, postcode: reservation.postcode || '' },
    payment_intent_data: {
      // What the customer sees on their bank statement. Getting this wrong is
      // the single fastest route to a chargeback from someone who doesn't
      // recognise the name.
      description: `SolarMOT deposit — ${reservation.postcode || 'visit'}`,
      metadata: { reservationId: reservation.id }
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'gbp',
        unit_amount: amount,
        product_data: {
          name: 'SolarMOT visit deposit',
          description: 'Refundable. Credited in full against your first month.'
        }
      }
    }]
  });

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `deposit-${reservation.id}`
    },
    body
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Stripe checkout session failed (${res.status})`);
    err.detail = json && json.error ? json.error.message : '';
    throw err;
  }
  return { id: json.id, url: json.url, amount };
}

/**
 * Verify a Stripe webhook signature.
 *
 * Header looks like: t=1492774577,v1=5257a869...,v1=<older key>
 * The signed payload is `${t}.${rawBody}`.
 *
 * The timestamp tolerance is what stops a replay: without it, anyone who ever
 * captured one valid webhook could resend it forever and keep marking deposits
 * as paid.
 */
function verifyWebhook(rawBody, signatureHeader, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !signatureHeader || typeof rawBody !== 'string') return false;

  const parts = String(signatureHeader).split(',').map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!timestamp || !signatures.length) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // Stripe may send several v1 values during a secret rotation; any match is valid.
  return signatures.some(sig => {
    const sigBuf = Buffer.from(sig, 'utf8');
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  });
}

module.exports = { createDepositSession, verifyWebhook, formEncode, depositPence, STRIPE_API };
