// The auto-reply the customer receives.
//
// Why this exists: without it, someone fills in a form on a company they have
// never heard of, sees a line of text on screen, and then hears nothing. The
// common outcome is they assume it failed and contact somebody else. An instant
// acknowledgement is one of the cheapest things a small service business can do
// to stop losing enquiries it has already won.
//
// Deliberate choices:
//
//  - It is PLAIN. Text and very light HTML, no images, no marketing styling, no
//    tracking. Partly because it reads like a person wrote it, and partly
//    because heavy promotional HTML from a brand-new domain is exactly what
//    Microsoft's filters treat as suspicious.
//  - It repeats back what they told us. That is the actual reassurance — it
//    proves the message arrived intact, not just that a server responded.
//  - It gives the phone number, because someone whose inverter has stopped
//    should not have to wait on email.
//  - reply_to is the business inbox, so a reply lands somewhere real.
//  - It NEVER fails the submission. The lead is already stored by the time this
//    runs; an acknowledgement problem must not turn a saved enquiry into an
//    error for the visitor.

const CONTACT_PHONE = '07891 110865';
const CONTACT_EMAIL = 'hello@solarmot.co.uk';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 5000;

const DEFAULT_FROM = 'SolarMOT <hello@solarmot.co.uk>';

/** How quickly we promise to reply. Kept in one place so it can't drift out of
 *  step with what the website says. */
const RESPONSE_TIME = 'within one working day';

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Per-form copy. Each one tells the customer what happens next, because
 * "we got it" is much less reassuring than "we got it and here is what follows".
 */
const TYPES = {
  enquiries: {
    subject: 'We\'ve got your enquiry — SolarMOT',
    opening: 'Thanks for getting in touch about your solar panels.',
    next: `We'll read this properly and come back to you ${RESPONSE_TIME}.`
  },
  bookings: {
    subject: 'We\'ve got your booking request — SolarMOT',
    opening: 'Thanks for booking a SolarMOT visit.',
    next: `This is a request rather than a confirmed appointment — we'll confirm the date and time with you ${RESPONSE_TIME}.`
  },
  'commercial-quotes': {
    subject: 'We\'ve got your quote request — SolarMOT',
    opening: 'Thanks for asking us about maintenance for your commercial system.',
    next: `We'll put together a quote and come back to you ${RESPONSE_TIME}. For larger arrays we may call first to check a few details.`
  },
  'interest-registrations': {
    subject: 'You\'re on the list — SolarMOT',
    opening: 'Thanks for registering your interest.',
    next: 'We\'re not covering your postcode yet, but you\'ll be the first to know when we do. We won\'t email you about anything else.'
  },
  // Money has changed hands here, so this one carries more weight than the
  // others. It has to state plainly that the deposit is refundable and that it
  // comes off the first month — someone who sees an unfamiliar name on their
  // statement and can't find that in writing raises a chargeback.
  reservations: {
    subject: 'Your October slot is reserved — SolarMOT',
    opening: 'Thanks for reserving an October slot.',
    next: 'We\'ll be in touch to agree a date once we\'re scheduling your area. '
        + 'Your £25 deposit comes off your first month — it isn\'t an extra charge — and it\'s '
        + 'fully refundable if you change your mind. Just reply to this email and we\'ll return it.'
  }
};

/** The fields worth reflecting back, in a sensible reading order. */
const ECHO_FIELDS = [
  ['name', 'Name'], ['company', 'Company'], ['contact', 'Contact'],
  ['address1', 'Address'], ['postcode', 'Postcode'],
  ['email', 'Email'], ['phone', 'Phone'],
  ['plan', 'Plan'], ['systemSize', 'System size'],
  ['preferredMonth', 'Preferred month'],
  ['requestedDate', 'Preferred date'], ['requestedSlot', 'Preferred time'],
  ['message', 'Your message']
];

/** '2026-10' reads as a database value. 'October 2026' reads as an answer. */
function friendlyMonth(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value));
  if (!m) return String(value);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function friendlyDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London'
  });
}

function summarise(record) {
  const rows = [];
  for (const [key, label] of ECHO_FIELDS) {
    let v = record[key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (key === 'requestedDate') v = friendlyDate(v);
    if (key === 'preferredMonth') v = friendlyMonth(v);
    // 'undecided' is a form value, not something to read back as a plan name.
    if (key === 'plan') {
      if (String(v).toLowerCase() === 'undecided') continue;
      v = String(v).charAt(0).toUpperCase() + String(v).slice(1);
    }
    rows.push([label, String(v)]);
  }
  return rows;
}

function buildAcknowledgement(storeName, record) {
  const type = TYPES[storeName];
  if (!type) return null;

  const firstName = String(record.name || record.contact || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const rows = summarise(record);

  const text = [
    greeting,
    '',
    type.opening,
    type.next,
    '',
    rows.length ? 'Here\'s what you sent us:' : null,
    ...rows.map(([label, v]) => `  ${label}: ${v}`),
    rows.length ? '' : null,
    `If it's urgent, or you'd rather talk it through, call ${CONTACT_PHONE}.`,
    '',
    'Rob',
    'SolarMOT',
    CONTACT_EMAIL,
    `${CONTACT_PHONE}`,
    '',
    '—',
    'You\'re getting this because you filled in a form on solarmot.co.uk.',
    'It\'s a one-off confirmation, not a mailing list.'
  ].filter(v => v !== null).join('\n');

  const rowsHtml = rows.map(([label, v]) => `
      <tr>
        <td style="padding:6px 16px 6px 0;color:#5B6B66;font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#0C1A16;font-size:14px;vertical-align:top;${label === 'Your message' ? 'white-space:pre-wrap;' : ''}">${escapeHtml(v)}</td>
      </tr>`).join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F6F8F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;">
    <p style="margin:0 0 14px;color:#0C1A16;font-size:15px;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px;color:#0C1A16;font-size:15px;line-height:1.55;">${escapeHtml(type.opening)}</p>
    <p style="margin:0 0 20px;color:#0C1A16;font-size:15px;line-height:1.55;">${escapeHtml(type.next)}</p>
    ${rows.length ? `<p style="margin:0 0 8px;color:#5B6B66;font-size:13px;">What you sent us</p>
    <table style="border-collapse:collapse;margin:0 0 20px;">${rowsHtml}</table>` : ''}
    <p style="margin:0 0 20px;color:#0C1A16;font-size:15px;line-height:1.55;">
      If it's urgent, or you'd rather talk it through, call
      <a href="tel:+447891110865" style="color:#0E7D53;">${escapeHtml(CONTACT_PHONE)}</a>.
    </p>
    <p style="margin:0;color:#0C1A16;font-size:15px;line-height:1.55;">
      Rob<br><span style="color:#5B6B66;">SolarMOT</span><br>
      <a href="mailto:${CONTACT_EMAIL}" style="color:#0E7D53;">${CONTACT_EMAIL}</a>
    </p>
    <p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #E6EBE9;color:#8A9691;font-size:12px;line-height:1.5;">
      You're getting this because you filled in a form on solarmot.co.uk.
      It's a one-off confirmation, not a mailing list.
    </p>
  </div>
</body></html>`;

  return { subject: type.subject, text, html };
}

/** Basic sanity check. Not full validation — just enough to avoid obvious junk. */
const looksLikeEmail = (v) => typeof v === 'string' && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v.trim());

/**
 * @returns {Promise<{sent: boolean, skipped?: boolean, reason?: string, id?: string}>}
 *          Never throws. Never rejects. The lead is already saved.
 */
async function sendAcknowledgement(storeName, record) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, skipped: true, reason: 'no-api-key' };

  // Opt-out switch, in case auto-replies ever need turning off in a hurry
  // without a code change.
  if (String(process.env.SEND_CUSTOMER_ACKNOWLEDGEMENT || '').toLowerCase() === 'false') {
    return { sent: false, skipped: true, reason: 'disabled' };
  }

  const to = String(record.email || '').trim();
  if (!looksLikeEmail(to)) return { sent: false, skipped: true, reason: 'no-usable-email' };

  // Never auto-reply to ourselves. A form submitted with the business address
  // would otherwise generate mail from the inbox to the inbox.
  const ownAddresses = [CONTACT_EMAIL, 'notifications@solarmot.co.uk'];
  if (ownAddresses.includes(to.toLowerCase())) {
    return { sent: false, skipped: true, reason: 'own-address' };
  }

  const built = buildAcknowledgement(storeName, record);
  if (!built) return { sent: false, skipped: true, reason: 'no-template' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ACKNOWLEDGEMENT_FROM || DEFAULT_FROM,
        to: [to],
        reply_to: CONTACT_EMAIL,
        subject: built.subject,
        text: built.text,
        html: built.html
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* non-JSON */ }
      return { sent: false, reason: `http-${res.status}`, detail };
    }
    const body = await res.json().catch(() => ({}));
    return { sent: true, id: body.id };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { sent: false, reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sendAcknowledgement, buildAcknowledgement, looksLikeEmail,
  TYPES, RESPONSE_TIME, CONTACT_PHONE, CONTACT_EMAIL
};
