// Shared behaviours across all pages: mobile nav toggle, footer year, active link.
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
  }

  // Mark the active nav link.
  //
  // Both sides are normalised to a bare page name because the deployed URLs
  // and the hrefs in the source don't necessarily match: Netlify's "Pretty
  // URLs" post-processing rewrites href="pricing.html" to href="/pricing",
  // while a visitor may still arrive on /pricing.html. Comparing raw strings
  // meant nothing was ever highlighted on the live site.
  const pageName = (value) => {
    const withoutQuery = (value || '').split('#')[0].split('?')[0];
    const base = withoutQuery.replace(/^.*\//, '').replace(/\.html$/i, '');
    return base === '' ? 'index' : base.toLowerCase();
  };
  const current = pageName(window.location.pathname);
  document.querySelectorAll('.nav-links a').forEach(a => {
    if (pageName(a.getAttribute('href')) === current) {
      a.classList.add('active');
    }
  });

  // Footer year
  document.querySelectorAll('[data-year]').forEach(el => {
    el.textContent = new Date().getFullYear();
  });

  // Header gains a border + shadow once the page is scrolled, so it sits
  // flush against the hero at rest but stays legible over content.
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Scroll-reveal for anything marked .reveal, staggered within a group so
  // rows of cards animate in sequence rather than all at once.
  //
  // This is position-based rather than IntersectionObserver-based on purpose:
  // an observer can miss elements entirely during a fast scroll or an anchor
  // jump (they enter and leave between callbacks), which would leave content
  // permanently invisible. Checking position on every frame of scroll means
  // anything at or above the fold is always revealed, however you got there.
  const revealEls = Array.from(document.querySelectorAll('.reveal'));
  if (revealEls.length) {
    let pending = revealEls.slice();
    let queued = false;

    const showEl = (el) => {
      const siblings = Array.from(el.parentElement ? el.parentElement.children : [])
        .filter(c => c.classList.contains('reveal') && pending.indexOf(c) !== -1);
      const i = Math.max(0, siblings.indexOf(el));
      el.style.transitionDelay = `${Math.min(i, 5) * 70}ms`;
      el.classList.add('in');
    };

    const sweep = () => {
      queued = false;
      const limit = window.innerHeight * 0.92;
      pending = pending.filter(el => {
        if (el.getBoundingClientRect().top < limit) { showEl(el); return false; }
        return true;
      });
      if (!pending.length) {
        window.removeEventListener('scroll', onScrollReveal);
        window.removeEventListener('resize', onScrollReveal);
      }
    };
    const onScrollReveal = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(sweep);
    };

    window.addEventListener('scroll', onScrollReveal, { passive: true });
    window.addEventListener('resize', onScrollReveal);
    sweep();
    // Belt and braces: if anything is somehow still hidden shortly after load
    // (late layout shift, webfont reflow), reveal it rather than lose it.
    window.setTimeout(sweep, 1200);
  }
});

const CONTACT_EMAIL = 'hello@solarmot.co.uk';
const CONTACT_PHONE = '07891 110865';

/**
 * Show an inline error inside a form, with a way for the visitor to reach us
 * anyway. Used when a submission genuinely failed to save — it is important
 * they find out, rather than being shown a success screen for a message that
 * was never recorded.
 */
function showFormError(form, message) {
  let box = form.querySelector('.form-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'form-error';
    box.setAttribute('role', 'alert');
    form.appendChild(box);
  }
  box.innerHTML =
    `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
    `<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>` +
    `<path d="M12 7.5v5M12 16.2h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>` +
    `<span><strong>${message}</strong><br>Please try again in a moment. If it keeps failing, ` +
    `email us at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> or call ` +
    `<a href="tel:+447891110865">${CONTACT_PHONE}</a> and we'll pick it up from there.</span>`;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearFormError(form) {
  const box = form.querySelector('.form-error');
  if (box) box.remove();
}

/**
 * POSTs form data as JSON to a Netlify Function (via the /api/* redirect in
 * netlify.toml).
 *
 * On failure this deliberately does NOT pretend to succeed. An earlier version
 * fell back to a simulated success on any error, which meant a visitor whose
 * enquiry hit a 500 was still shown "thanks, we'll be in touch" while the lead
 * was silently lost. Now:
 *
 *   - 2xx                        -> real success
 *   - any error response, or a
 *     network failure on a real
 *     http(s) origin             -> visible error + a way to contact us
 *   - network failure on file://  -> simulated success, because that is
 *                                   someone previewing the raw HTML locally
 *                                   with no backend to talk to
 *
 * @param {HTMLFormElement} form
 * @param {string} endpoint  e.g. '/api/submit-enquiry'
 * @param {(result: object, wasReal: boolean) => void} onSuccess
 * @param {object} [extraFields]  extra key/values to merge into the payload
 *                                (e.g. selected booking slot) that aren't
 *                                plain form fields.
 * @returns {Promise<boolean>} whether the submission succeeded
 */
async function submitForm(form, endpoint, onSuccess, extraFields = {}) {
  const buttons = form.querySelectorAll('button[type="submit"]');
  buttons.forEach(b => {
    b.disabled = true;
    if (b.dataset.originalText === undefined) b.dataset.originalText = b.textContent;
    b.textContent = 'Sending…';
  });
  clearFormError(form);

  const payload = {};
  new FormData(form).forEach((value, key) => { payload[key] = value; });
  Object.assign(payload, extraFields);

  const isLocalPreview = window.location.protocol === 'file:';
  let ok = false;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      let result = {};
      try { result = await res.json(); } catch { /* empty body is fine */ }
      onSuccess(result, true);
      ok = true;
    } else {
      // The server answered and said no. Never fake a success here.
      let detail = '';
      try {
        const body = await res.json();
        detail = body && body.error ? body.error : '';
      } catch { /* non-JSON error body */ }
      console.error(`[${endpoint}] failed with ${res.status}`, detail);
      showFormError(
        form,
        res.status >= 500
          ? "Sorry — we couldn't save that just now."
          : (detail || 'Please check the details above and try again.')
      );
    }
  } catch (err) {
    // Could not reach the endpoint at all.
    if (isLocalPreview) {
      console.warn(`[local preview] no backend at ${endpoint}; simulating success. (${err.message})`);
      await new Promise(r => setTimeout(r, 400));
      onSuccess({ demo: true }, false);
      ok = true;
    } else {
      console.error(`[${endpoint}] network error`, err);
      showFormError(form, 'We could not reach our servers — check your connection.');
    }
  } finally {
    buttons.forEach(b => {
      b.disabled = false;
      b.textContent = b.dataset.originalText;
    });
  }

  return ok;
}
