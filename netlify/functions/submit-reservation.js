// POST /api/submit-reservation
//
// October slot reservations — the demand-validation step. Kept in its own store
// rather than mixed with enquiries, because the whole point is to count these
// specifically: how many people, from which streets, were willing to commit.
//
// depositStatus starts as 'pending'. Once Stripe is wired the Checkout webhook
// moves it to 'paid'. Recording the reservation BEFORE payment is deliberate:
// somebody who fills the form and then abandons at the card screen is a real
// signal worth keeping, and if payment later fails we still know who tried.
const { handleSubmission } = require('./_lib/store');

// Only months we are actually offering. An arbitrary string here would let
// somebody reserve a slot in a month that does not exist.
const OFFERED_MONTHS = ['2026-10', '2026-11'];
const PLANS = ['essential', 'standard', 'premium', 'undecided'];

exports.handler = (event) => handleSubmission(event, {
  storeName: 'reservations',
  prefix: 'reservation',
  required: ['name', 'email', 'address1', 'postcode'],
  build: (data) => ({
    name: data.name,
    email: data.email,
    phone: data.phone || null,
    address1: data.address1,
    postcode: data.postcode,
    // Fall back rather than reject: a bad value here is far more likely to be a
    // stale cached page than an attack, and losing the reservation would cost
    // more than storing a default.
    preferredMonth: OFFERED_MONTHS.includes(data.preferredMonth) ? data.preferredMonth : OFFERED_MONTHS[0],
    plan: PLANS.includes(String(data.plan || '').toLowerCase()) ? String(data.plan).toLowerCase() : 'undecided',
    panelAge: data.panelAge || null,
    notes: data.notes || null,
    depositStatus: 'pending',
    depositAmount: null,
    paidAt: null
  })
});

module.exports.OFFERED_MONTHS = OFFERED_MONTHS;
module.exports.PLANS = PLANS;
