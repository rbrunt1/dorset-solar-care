// POST /api/gocardless-webhook
//
// The missing half of the payment flow. Previously the site created a Direct
// Debit MANDATE and stopped there — a mandate is only permission to collect;
// it does not collect anything. Nobody would ever have been billed.
//
// This does two jobs:
//   1. Verifies the webhook really came from GoCardless (HMAC-SHA256 of the
//      raw body against GOCARDLESS_WEBHOOK_SECRET). Without this anyone who
//      finds the URL could POST "mandate active" and get free service.
//   2. On mandate activation, creates the actual recurring SUBSCRIPTION at the
//      right plan price, and writes the customer into the visit schedule.
//
// Status is only ever set from a verified webhook — never from the browser
// redirect, which anyone can forge by visiting /signup?gc_status=success.

const crypto = require('node:crypto');
const { jsonResponse, openStore, readAll } = require('./_lib/store');
const { customerFromLead } = require('./_lib/schedule');

const GC_API_VERSION = '2015-07-06';

// Pence per month, and the GoCardless day-of-month anchor.
const PLAN_PRICING = {
  essential: { amount: 1999, name: 'SolarMOT Essential' },
  standard:  { amount: 2999, name: 'SolarMOT Standard' },
  premium:   { amount: 3999, name: 'SolarMOT Premium' }
};

function apiBase() {
  return process.env.GOCARDLESS_ENVIRONMENT === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
}

/**
 * Constant-time verification of the GoCardless signature over the RAW body.
 * Parsing first and re-serialising would change the bytes and break the HMAC,
 * which is why the raw string is used here.
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function gcFetch(path, options = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
      'GoCardless-Version': GC_API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GoCardless ${path} failed (${res.status})`);
    err.detail = body;
    throw err;
  }
  return body;
}

/**
 * Create the recurring subscription once a mandate is active.
 *
 * Idempotency matters: GoCardless retries webhooks, and a duplicate would
 * bill the customer twice a month forever. The mandate id is used as the
 * idempotency key so a retry returns the existing subscription instead.
 */
async function createSubscription(mandateId, plan) {
  const pricing = PLAN_PRICING[String(plan).toLowerCase()] || PLAN_PRICING.standard;
  return gcFetch('/subscriptions', {
    method: 'POST',
    headers: { 'Idempotency-Key': `sub-${mandateId}` },
    body: JSON.stringify({
      subscriptions: {
        amount: pricing.amount,
        currency: 'GBP',
        name: pricing.name,
        interval_unit: 'monthly',
        metadata: { plan: String(plan || '').toLowerCase() },
        links: { mandate: mandateId }
      }
    })
  });
}

/** Find the customer holding a mandate. Uses the batched reader rather than a
 *  sequential loop — a webhook that times out gets retried, and a retried
 *  subscription creation is a double charge. */
async function findByMandate(store, mandateId) {
  if (!mandateId) return null;
  const { records } = await readAll(store, { label: 'customers' });
  const hit = records.find(r => r.value && r.value.gcMandateId === mandateId);
  return hit ? { ...hit.value, id: hit.value.id || hit.key } : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const secret = process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed, exactly like the admin auth: an unverifiable webhook is
    // worse than no webhook, because it would let anyone activate an account.
    console.error('[gc-webhook] GOCARDLESS_WEBHOOK_SECRET is not set — refusing.');
    return jsonResponse(503, { error: 'Webhook not configured' });
  }

  const raw = event.body || '';
  const signature = event.headers?.['webhook-signature'] || event.headers?.['Webhook-Signature'];
  if (!verifySignature(raw, signature, secret)) {
    console.warn('[gc-webhook] rejected a request with a bad or missing signature.');
    return jsonResponse(401, { error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return jsonResponse(400, { error: 'Invalid JSON' }); }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const results = [];

  for (const ev of events) {
    try {
      if (ev.resource_type === 'mandates' && ev.action === 'active') {
        const mandateId = ev.links?.mandate;
        const store = openStore(event, 'customers');

        // Have we already handled this mandate? GoCardless retries, and a
        // duplicate would create a second subscription against the same
        // mandate — billing the customer twice, every month, forever.
        const existing = await findByMandate(store, mandateId);

        const plan = ev.metadata?.plan || existing?.plan || 'standard';
        const sub = await createSubscription(mandateId, plan);
        const subscriptionId = sub.subscriptions?.id;

        const record = existing
          ? { ...existing, status: 'active', gcSubscriptionId: subscriptionId, activatedAt: new Date().toISOString() }
          : {
              ...customerFromLead({ name: 'Pending — from GoCardless', plan }, { plan, status: 'active' }),
              gcMandateId: mandateId,
              gcSubscriptionId: subscriptionId,
              activatedAt: new Date().toISOString()
            };

        await store.setJSON(record.id, record);
        console.log(`[gc-webhook] mandate ${mandateId} active -> subscription ${subscriptionId}`);
        results.push({ event: ev.id, handled: 'subscription_created', subscriptionId });

      } else if (ev.resource_type === 'payments' && ev.action === 'failed') {
        console.warn('[gc-webhook] payment failed', ev.links?.payment);
        results.push({ event: ev.id, handled: 'payment_failed_logged' });

      } else if (ev.resource_type === 'mandates' && ev.action === 'cancelled') {
        const store = openStore(event, 'customers');
        const found = await findByMandate(store, ev.links?.mandate);
        if (found) {
          await store.setJSON(found.id, { ...found, status: 'cancelled', cancelledAt: new Date().toISOString() });
        } else {
          console.warn('[gc-webhook] cancelled mandate with no matching customer:', ev.links?.mandate);
        }
        results.push({ event: ev.id, handled: 'customer_cancelled' });

      } else {
        results.push({ event: ev.id, handled: 'ignored' });
      }
    } catch (err) {
      // Log and continue: one bad event must not stop the rest, and a 500
      // would make GoCardless retry the whole batch including the ones we
      // already processed.
      console.error('[gc-webhook] event failed:', ev.id, err.message, err.detail || '');
      results.push({ event: ev.id, handled: 'error', error: err.message });
    }
  }

  return jsonResponse(200, { ok: true, processed: results.length, results });
};

module.exports.verifySignature = verifySignature;
module.exports.PLAN_PRICING = PLAN_PRICING;
