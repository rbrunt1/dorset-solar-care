/**
 * Simple postcode-prefix based coverage check.
 *
 * This is a lightweight demo, matching on the outward code's letter prefix
 * only, not a validated/geocoded postcode lookup. For production, wire this
 * to a real postcode API (e.g. postcodes.io for lookup/validation) and a
 * proper service-area polygon or postcode-district list maintained by ops.
 */

const COVERED_NOW = ['DT', 'BH']; // Dorset — current launch area
const COMING_PHASE_2 = ['SP', 'SO', 'PO', 'EX', 'TA', 'TQ', 'PL', 'GU', 'RH', 'BN']; // South West / South Coast — Year 2

function checkPostcode(raw) {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '');
  const match = cleaned.match(/^([A-Z]{1,2})/);
  const prefix = match ? match[1] : '';

  if (COVERED_NOW.includes(prefix)) {
    return { status: 'live', prefix };
  }
  if (COMING_PHASE_2.includes(prefix)) {
    return { status: 'soon', prefix };
  }
  return { status: 'later', prefix };
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('postcode-form');
  if (!form) return;
  const input = document.getElementById('postcode-input');
  const banner = document.getElementById('postcode-result');
  const interestCapture = document.getElementById('interest-capture');
  const interestForm = document.getElementById('interest-form');
  const interestSuccess = document.getElementById('interest-success');
  const interestPostcodeField = document.getElementById('interest-postcode');
  const interestStatusField = document.getElementById('interest-status');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const result = checkPostcode(input.value);
    banner.className = 'result-banner show';

    if (result.status === 'live') {
      banner.classList.add('in-area');
      banner.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#146c4e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span><strong>Great news!</strong> ${result.prefix ? result.prefix + ' postcodes are' : 'You are'} in our current Dorset coverage area. <a href="pricing.html">See plans →</a></span>`;

      // Fully covered already — no need to register interest.
      interestCapture.style.display = 'none';
      interestForm.style.display = '';
      interestSuccess.style.display = 'none';
      interestForm.reset();
    } else {
      const isSoon = result.status === 'soon';
      banner.classList.add('out-area');
      banner.innerHTML = isSoon
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.3 3.9L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke="#b8791f" stroke-width="1.7" stroke-linejoin="round"/></svg>
        <span><strong>Coming in Year 2:</strong> we're not in your area yet, but South West/South Coast expansion is next on our roadmap.</span>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.3 3.9L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke="#b8791f" stroke-width="1.7" stroke-linejoin="round"/></svg>
        <span><strong>Not yet, but stay tuned:</strong> we're planning national coverage from Year 3.</span>`;

      // Out of area — show the inline interest-capture form, pre-tagged
      // with the postcode they just checked and which phase they fall into.
      interestForm.style.display = '';
      interestSuccess.style.display = 'none';
      interestForm.reset();
      interestPostcodeField.value = input.value.trim();
      interestStatusField.value = result.status;
      interestCapture.style.display = 'block';
    }
  });

  if (interestForm) {
    interestForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitForm(interestForm, '/api/register-interest', () => {
        interestForm.style.display = 'none';
        interestSuccess.style.display = 'block';
      });
    });
  }
});
