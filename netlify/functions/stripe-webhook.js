// POST /api/stripe-webhook
//
// Marks a reservation's deposit as paid. This is the ONLY thing that may do so
// — never the browser redirect, which anyone can forge by visiting
// /reserve-confirmed?ref=... directly.
const { jsonResponse, openStore } = require('./_lib/store');
const { verifyWebhook } = require('./_lib/stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed. An unverified payment webhook would let anyone mark any
    // reservation as paid.
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing.');
    return jsonResponse(503, { error: 'Webhook not configured' });
  }

  const raw = event.body || '';
  const sig = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];
  if (!verifyWebhook(raw, sig, secret)) {
    console.warn('[stripe-webhook] rejected a request with a bad, missing or stale signature.');
    return jsonResponse(401, { error: 'Invalid signature' });
  }

  let evt;
  try { evt = JSON.parse(raw); }
  catch { return jsonResponse(400, { error: 'Invalid JSON' }); }

  try {
    if (evt.type === 'checkout.session.completed') {
      const session = evt.data?.object || {};
      const reservationId = session.metadata?.reservationId || session.client_reference_id;
      if (!reservationId) {
        console.warn('[stripe-webhook] completed session with no reservation reference:', session.id);
        return jsonResponse(200, { ok: true, handled: 'no-reference' });
      }

      const store = openStore(event, 'reservations');
      const reservation = await store.get(reservationId, { type: 'json' });
      if (!reservation) {
        console.error(`[stripe-webhook] paid session for unknown reservation ${reservationId}`);
        // 200 so Stripe stops retrying something we cannot fix.
        return jsonResponse(200, { ok: true, handled: 'unknown-reservation' });
      }

      if (reservation.depositStatus === 'paid') {
        return jsonResponse(200, { ok: true, handled: 'already-paid' });
      }

      await store.setJSON(reservationId, {
        ...reservation,
        depositStatus: 'paid',
        depositAmount: session.amount_total ?? reservation.depositAmount,
        paidAt: new Date().toISOString(),
        stripeSessionId: session.id,
        stripePaymentIntent: session.payment_intent || null
      });
      console.log(`[stripe-webhook] deposit paid for ${reservationId} (${session.amount_total}p)`);
      return jsonResponse(200, { ok: true, handled: 'deposit-paid' });
    }

    return jsonResponse(200, { ok: true, handled: 'ignored', type: evt.type });
  } catch (err) {
    // 500 so Stripe retries — a transient Blobs failure shouldn't lose a payment.
    console.error('[stripe-webhook] handler failed:', err.message);
    return jsonResponse(500, { error: 'Could not process event' });
  }
};
