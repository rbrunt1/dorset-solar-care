// POST /api/create-deposit-checkout   { reservationId }
//
// Returns a Stripe Checkout URL for an existing reservation. Called by the
// reserve page immediately after the reservation is saved.
//
// The amount is NEVER taken from the request — it is a server-side constant in
// _lib/stripe.js. Accepting a price from the browser would let anyone reserve
// a slot for a penny.
const { jsonResponse, openStore } = require('./_lib/store');
const { createDepositSession } = require('./_lib/stripe');
const { checkSubmissionLimit } = require('./_lib/publiclimit');
const { requestId, line } = require('./_lib/log');
const { hasClientHeader } = require('./_lib/ratelimit');

const STORE = 'reservations';

function siteUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://solarmot.co.uk';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const rid = requestId(event);

  const flood = await checkSubmissionLimit(openStore, event);
  if (flood.limited) {
    return jsonResponse(429, { error: 'Too many requests. Please try again shortly.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const reservationId = String(body.reservationId || '').trim();
  // Only ever ids we generated. This is also what stops the endpoint being used
  // to probe the store with arbitrary keys.
  if (!/^reservation-\d+-[a-z0-9]+$/.test(reservationId)) {
    return jsonResponse(400, { error: 'Unknown reservation' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error(line(STORE, rid, 'STRIPE_NOT_CONFIGURED', 'STRIPE_SECRET_KEY is not set'));
    return jsonResponse(503, { error: 'Payments are not set up yet. Please call us instead.' });
  }

  try {
    const store = openStore(event, STORE);
    const reservation = await store.get(reservationId, { type: 'json' });
    if (!reservation) return jsonResponse(404, { error: 'Unknown reservation' });

    // Already paid: don't create a second session or take a second deposit.
    if (reservation.depositStatus === 'paid') {
      console.log(line(STORE, rid, 'deposit-already-paid', `id=${reservationId}`));
      return jsonResponse(200, { ok: true, alreadyPaid: true });
    }

    const session = await createDepositSession({
      reservation: { ...reservation, id: reservationId },
      siteUrl: siteUrl(),
      apiKey: process.env.STRIPE_SECRET_KEY
    });

    await store.setJSON(reservationId, {
      ...reservation,
      stripeSessionId: session.id,
      depositAmount: session.amount,
      checkoutStartedAt: new Date().toISOString()
    });

    console.log(line(STORE, rid, 'checkout-created', `id=${reservationId} amount=${session.amount}`));
    return jsonResponse(200, { ok: true, url: session.url });

  } catch (err) {
    console.error(line(STORE, rid, 'CHECKOUT_FAILED',
                       `id=${reservationId} error=${JSON.stringify(String(err.message))} ${err.detail || ''}`));
    // The reservation IS saved. Say so, rather than implying it was lost.
    return jsonResponse(502, {
      error: 'We saved your reservation but could not open the payment page. We will be in touch.'
    });
  }
};
