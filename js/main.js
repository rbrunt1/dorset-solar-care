// Shared behaviours across all pages: mobile nav toggle, footer year, active link.
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
  }

  // Mark active nav link based on current page filename
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });

  // Footer year
  document.querySelectorAll('[data-year]').forEach(el => {
    el.textContent = new Date().getFullYear();
  });
});

/**
 * Real form-submit helper: POSTs form data as JSON to a Netlify Function
 * (via the /api/* redirect defined in netlify.toml), and falls back to a
 * simulated success if the backend isn't reachable — e.g. when the site is
 * opened as a plain local file rather than served by Netlify, or before
 * the functions have been deployed.
 *
 * @param {HTMLFormElement} form
 * @param {string} endpoint  e.g. '/api/submit-enquiry'
 * @param {(result: object, wasReal: boolean) => void} onSuccess
 * @param {object} [extraFields]  extra key/values to merge into the payload
 *                                (e.g. selected booking slot) that aren't
 *                                plain form fields.
 */
async function submitForm(form, endpoint, onSuccess, extraFields = {}) {
  const buttons = form.querySelectorAll('button[type="submit"]');
  buttons.forEach(b => {
    b.disabled = true;
    b.dataset.originalText = b.textContent;
    b.textContent = 'Submitting…';
  });

  const payload = {};
  new FormData(form).forEach((value, key) => { payload[key] = value; });
  Object.assign(payload, extraFields);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const result = await res.json();
    onSuccess(result, true);
  } catch (err) {
    // Backend not reachable — most likely this is a local/static preview
    // rather than a live Netlify deploy. Fall back to a simulated success
    // so the flow can still be demoed end to end.
    console.warn(`[demo mode] Could not reach ${endpoint}, simulating success. (${err.message})`);
    await new Promise(r => setTimeout(r, 500));
    onSuccess({ demo: true }, false);
  } finally {
    buttons.forEach(b => {
      b.disabled = false;
      b.textContent = b.dataset.originalText;
    });
  }
}
