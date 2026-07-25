/**
 * Sign-up flow controller: plan -> details -> Direct Debit (mock) -> booking -> done.
 *
 * BACKEND WIRING NEEDED (see also inline .integration-note blocks in signup.html):
 * - Step "details" should ultimately POST the customer record to a backend
 *   (creating a customer/lead in your system) rather than just holding it in
 *   memory client-side.
 * - Step "payment" mocks the GoCardless Billing Request + Billing Request
 *   Flow handshake. A real build creates the Billing Request server-side
 *   (with a mandate_request for scheme "bacs", currency "GBP"), creates a
 *   Billing Request Flow with redirect_uri/exit_uri (optionally prefilling
 *   the customer details captured in step 2), and redirects the browser to
 *   the returned authorisation_url. The subscription should only be marked
 *   active after GoCardless confirms the mandate via webhook.
 * - Step "booking" mocks available slots; wire to a real scheduling backend.
 * - On final confirmation, all of the above should be persisted server-side
 *   and a confirmation email/SMS triggered.
 */

// `survey` is the one-off initial Solar MOT on a system we didn't install —
// which is everyone, since we're a maintenance provider rather than an
// installer. It must be shown before the Direct Debit step, not after: a
// mandatory up-front charge that only appears at checkout is both bad
// practice and a consumer-transparency problem.
const PLAN_INFO = {
  essential: { name: 'Essential', price: '£19.99/month', cadence: 'Annual clean', survey: 149 },
  standard:  { name: 'Standard',  price: '£29.99/month', cadence: 'Biannual clean + minor repairs', survey: 75 },
  premium:   { name: 'Premium',   price: '£39.99/month', cadence: 'Biannual clean + 2 priority callouts', survey: 0 }
};

const formatSurvey = (n) => (n === 0 ? 'Included free' : `£${n} one-off`);

const state = {
  plan: null,
  details: {},
  booking: null
};

const SESSION_KEY = 'dsc-signup-state';

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const gcStatus = params.get('gc_status');

  // Returning from a real GoCardless authorisation redirect.
  if (gcStatus) {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      const restored = JSON.parse(saved);
      state.plan = restored.plan;
      state.details = restored.details;
      selectPlan(state.plan);
      fillDetailsForm(state.details);
      renderPaymentSummary();
    }
    goToStep('payment');
    if (gcStatus === 'success') {
      showGcResult('done', 'Direct Debit mandate authorised via GoCardless.');
      document.getElementById('to-booking').disabled = false;
    } else {
      showGcResult('error', 'Direct Debit setup was cancelled or did not complete. You can try again below.');
    }
    // Clean the query string so refreshing doesn't replay this state.
    window.history.replaceState({}, '', 'signup.html');
  }

  // Preselect plan from ?plan= query param
  const preselect = params.get('plan');
  if (preselect && PLAN_INFO[preselect]) {
    selectPlan(preselect);
  }

  document.querySelectorAll('#plan-tiles .radio-tile').forEach(tile => {
    tile.addEventListener('click', () => selectPlan(tile.dataset.plan));
  });

  document.getElementById('to-details').addEventListener('click', () => goToStep('details'));

  document.getElementById('details-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.details = {
      firstName: document.getElementById('d-first').value,
      lastName: document.getElementById('d-last').value,
      email: document.getElementById('d-email').value,
      phone: document.getElementById('d-phone').value,
      address1: document.getElementById('d-addr1').value,
      city: document.getElementById('d-city').value,
      postcode: document.getElementById('d-postcode').value,
      notes: document.getElementById('d-notes').value
    };
    renderPaymentSummary();
    goToStep('payment');
  });

  document.getElementById('start-mandate').addEventListener('click', startGoCardlessMandate);

  document.getElementById('to-booking').addEventListener('click', () => goToStep('booking'));

  initBookingWidget(document.getElementById('booking-widget'), (selection) => {
    state.booking = selection;
    document.getElementById('to-done').disabled = false;
  });

  document.getElementById('to-done').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Finishing…';
    const saved = await submitFinalBooking();
    btn.disabled = false;
    btn.textContent = original;
    renderFinalSummary(saved);
    goToStep('done');
  });

  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => goToStep(btn.dataset.back));
  });
});

function fillDetailsForm(details) {
  if (!details) return;
  document.getElementById('d-first').value = details.firstName || '';
  document.getElementById('d-last').value = details.lastName || '';
  document.getElementById('d-email').value = details.email || '';
  document.getElementById('d-phone').value = details.phone || '';
  document.getElementById('d-addr1').value = details.address1 || '';
  document.getElementById('d-city').value = details.city || '';
  document.getElementById('d-postcode').value = details.postcode || '';
  document.getElementById('d-notes').value = details.notes || '';
}

function showGcResult(kind, text) {
  document.getElementById('gc-idle').style.display = 'none';
  document.getElementById('gc-loading').style.display = 'none';
  document.getElementById('gc-done').style.display = kind === 'done' ? 'block' : 'none';
  document.getElementById('gc-error').style.display = kind === 'error' ? 'block' : 'none';
  if (kind === 'done') document.getElementById('gc-done-text').textContent = text;
  if (kind === 'error') document.getElementById('gc-error-text').textContent = text;
}

async function startGoCardlessMandate() {
  document.getElementById('gc-idle').style.display = 'none';
  document.getElementById('gc-error').style.display = 'none';
  document.getElementById('gc-loading').style.display = 'block';
  document.getElementById('gc-loading-text').textContent = 'Connecting to GoCardless…';

  // Persist state so it survives the redirect round-trip to GoCardless.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ plan: state.plan, details: state.details }));

  try {
    const res = await fetch('/api/gocardless-create-billing-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: state.plan, customer: state.details })
    });
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const result = await res.json();

    if (result.authorisation_url) {
      // Real GoCardless flow: hand off to the customer's bank via GoCardless.
      document.getElementById('gc-loading-text').textContent = 'Redirecting you to your bank via GoCardless…';
      window.location.href = result.authorisation_url;
      return;
    }

    if (result.mock) {
      // Backend reachable, but no GOCARDLESS_ACCESS_TOKEN configured, so NO
      // mandate exists. Never tell the customer it was authorised: they would
      // believe they are paying, we would never collect, and we would turn up
      // to a visit nobody is being billed for. Fail visibly instead.
      if (isLocalPreview()) {
        showGcResult('done', 'Direct Debit step simulated — local preview only, no mandate was created.');
        document.getElementById('to-booking').disabled = false;
        return;
      }
      console.error('[signup] GoCardless is not configured — no mandate created.');
      showGcResult('error', "We can't set up Direct Debits just yet. Nothing has been taken and no payment " +
        'details were stored. Email hello@solarmot.co.uk or call 07891 110865 and we\'ll get you booked in directly.');
      return;
    }

    throw new Error('Unexpected response from GoCardless function.');
  } catch (err) {
    // Only simulate on a raw file:// preview, where there is no backend by
    // definition. On the real site a failure here must surface, for the same
    // reason as above.
    if (isLocalPreview()) {
      console.warn('[local preview] GoCardless backend not reachable, simulating success.', err);
      await new Promise(r => setTimeout(r, 900));
      showGcResult('done', 'Direct Debit step simulated — local preview only, no mandate was created.');
      document.getElementById('to-booking').disabled = false;
      return;
    }
    console.error('[signup] GoCardless request failed', err);
    showGcResult('error', "We couldn't reach our payment provider. Nothing has been taken. Please try again " +
      "in a moment, or email hello@solarmot.co.uk and we'll set you up directly.");
  }
}

/** A raw file:// preview has no backend, so simulation there is honest. */
function isLocalPreview() {
  return window.location.protocol === 'file:';
}

/**
 * Record the requested first visit.
 *
 * Returns whether it was actually saved. This matters: by this point the
 * customer may already have authorised a real Direct Debit mandate, so we
 * can't just block them — but we also must not tell them their appointment is
 * confirmed if we failed to record it. The caller shows a clear warning on the
 * confirmation screen when this returns false.
 */
async function submitFinalBooking() {
  if (!state.booking) return false;
  const payload = {
    name: `${state.details.firstName} ${state.details.lastName}`.trim(),
    email: state.details.email,
    phone: state.details.phone,
    postcode: state.details.postcode,
    plan: state.plan,
    date: state.booking.date.toISOString(),
    slot: state.booking.slot.label
  };

  let saved = false;
  try {
    const res = await fetch('/api/submit-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    saved = res.ok;
    if (!res.ok) console.error(`[submit-booking] failed with ${res.status}`);
  } catch (err) {
    if (window.location.protocol === 'file:') {
      // Local preview of the raw HTML — there is no backend to talk to.
      console.warn('[local preview] no backend for /api/submit-booking; treating as saved.');
      saved = true;
    } else {
      console.error('[submit-booking] network error', err);
    }
  }

  sessionStorage.removeItem(SESSION_KEY);
  return saved;
}

function selectPlan(planKey) {
  state.plan = planKey;
  document.querySelectorAll('#plan-tiles .radio-tile').forEach(t => {
    const isSelected = t.dataset.plan === planKey;
    t.classList.toggle('selected', isSelected);
    t.querySelector('input').checked = isSelected;
  });
  document.getElementById('to-details').disabled = false;
}

function renderPaymentSummary() {
  const info = PLAN_INFO[state.plan];
  document.getElementById('payment-summary').innerHTML = `
    <div class="summary-row"><span>Plan</span><span>${info.name}</span></div>
    <div class="summary-row"><span>Includes</span><span>${info.cadence}</span></div>
    <div class="summary-row"><span>Billed to</span><span>${state.details.firstName} ${state.details.lastName}</span></div>
    <div class="summary-row"><span>Initial Solar MOT survey</span><span>${formatSurvey(info.survey)}</span></div>
    <div class="summary-row"><span>Monthly amount</span><span>${info.price}</span></div>
  `;
}

/**
 * @param {boolean} bookingSaved whether the requested visit was actually
 *        recorded. If it wasn't, say so plainly rather than showing a
 *        confirmation for an appointment that doesn't exist on our side.
 */
function renderFinalSummary(bookingSaved = true) {
  const info = PLAN_INFO[state.plan];
  const b = state.booking;
  const dateStr = b ? b.date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '—';
  document.getElementById('final-summary').innerHTML = `
    <div class="summary-row"><span>Plan</span><span>${info.name} — ${info.price}</span></div>
    <div class="summary-row"><span>Customer</span><span>${state.details.firstName} ${state.details.lastName}</span></div>
    <div class="summary-row"><span>Address</span><span>${state.details.address1}, ${state.details.city} ${state.details.postcode}</span></div>
    <div class="summary-row"><span>Requested first visit</span><span>${dateStr}, ${b ? b.slot.label : '—'}</span></div>
  `;

  const warn = document.getElementById('booking-save-warning');
  if (warn) warn.style.display = bookingSaved ? 'none' : 'flex';
  const heading = document.getElementById('done-heading');
  const blurb = document.getElementById('done-blurb');
  if (heading && blurb) {
    if (bookingSaved) {
      heading.textContent = "You're all set!";
      blurb.textContent = "Your plan is set up. We'll confirm your first appointment time by email shortly.";
    } else {
      heading.textContent = 'Your plan is set up';
      blurb.textContent = 'There was one problem, explained below — please read it before you go.';
    }
  }
}

function goToStep(stepName) {
  document.querySelectorAll('.step-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === stepName));

  const order = ['plan', 'details', 'payment', 'booking', 'done'];
  const currentIndex = order.indexOf(stepName);
  document.querySelectorAll('#steps-nav li').forEach(li => {
    const idx = order.indexOf(li.dataset.step);
    li.classList.remove('current', 'done');
    if (idx < currentIndex) li.classList.add('done');
    if (idx === currentIndex) li.classList.add('current');
  });

  window.scrollTo({ top: document.querySelector('.page-header').offsetTop, behavior: 'smooth' });
}
