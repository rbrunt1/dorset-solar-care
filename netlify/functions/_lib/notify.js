// Lead notification emails via Resend (https://resend.com).
//
// WHY RESEND: it's a plain HTTPS POST with a bearer token, so there's no SDK to
// add to the function bundle, and the free tier (3,000 emails/month) is far
// more headroom than a small business needs — Postmark's free tier is 100/month,
// which a launch could burn through in a week.
//
// DESIGN RULE — notifications must never cost us a lead.
// By the time this runs the submission is already safely stored. So every
// failure path here is swallowed and logged: a Resend outage, a missing API
// key, a bad address or a hanging request must NOT turn a saved lead into an
// error for the visitor. This module never throws.
//
// REQUIRED ENV VAR (set in Netlify > Site configuration > Environment variables):
//   RESEND_API_KEY   — from https://resend.com/api-keys
//
// OPTIONAL ENV VARS:
//   LEAD_NOTIFICATION_TO    — recipient(s), comma-separated. Default below.
//   LEAD_NOTIFICATION_FROM  — must be on a domain verified in Resend.
//
// Until RESEND_API_KEY is set, this no-ops and logs — submissions still work.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Rob's mailbox. Deliberately not hello@solarmot.co.uk: that address is
// advertised on the site but there's no evidence a mailbox or forwarding rule
// exists for it yet, and silently emailing a black hole is exactly the failure
// mode we're trying to eliminate.
const DEFAULT_TO = 'robertbrunt@hotmail.co.uk';
const DEFAULT_FROM = 'SolarMOT <notifications@solarmot.co.uk>';

// How long to wait on Resend before giving up. Netlify Functions have a hard
// execution limit; a hanging email call must not eat it.
const SEND_TIMEOUT_MS = 5000;

const TYPES = {
  'enquiries': { label: 'enquiry', subject: 'New enquiry' },
  'commercial-quotes': { label: 'commercial quote request', subject: 'New commercial quote request' },
  'bookings': { label: 'booking request', subject: 'New booking request' },
  'interest-registrations': { label: 'interest registration', subject: 'New interest registration' }
};

const FIELD_LABELS = {
  name: 'Name', email: 'Email', phone: 'Phone', postcode: 'Postcode',
  message: 'Message', systemSize: 'System size', company: 'Company',
  contact: 'Contact', serviceLevel: 'Service level', plan: 'Plan',
  status: 'Customer type', requestedDate: 'Requested date',
  requestedSlot: 'Requested slot', coverageStatus: 'Coverage status',
  receivedAt: 'Received', id: 'Reference'
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function formatValue(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (key === 'receivedAt' || key === 'requestedDate') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London'
      });
    }
  }
  if (key === 'coverageStatus') {
    return value === 'soon' ? 'Year 2 area (South West / South Coast)'
         : value === 'later' ? 'Year 3+ area (outside current roadmap)'
         : String(value);
  }
  return String(value);
}

/** Order fields so the useful ones lead, then anything else, then metadata. */
function orderedEntries(record) {
  const lead = ['name', 'company', 'contact', 'email', 'phone', 'postcode'];
  const tail = ['id', 'receivedAt'];
  const keys = Object.keys(record);
  const middle = keys.filter(k => !lead.includes(k) && !tail.includes(k));
  return [...lead, ...middle, ...tail]
    .filter(k => keys.includes(k))
    .map(k => [k, formatValue(k, record[k])])
    .filter(([, v]) => v !== null);
}

function buildEmail(storeName, record, siteUrl) {
  const type = TYPES[storeName] || { label: 'submission', subject: 'New submission' };
  const who = record.name || record.company || record.contact || record.email || 'someone';
  const entries = orderedEntries(record);

  const subject = `${type.subject} — ${who}`;

  const textLines = [
    `A new ${type.label} came in via ${siteUrl || 'the SolarMOT site'}.`,
    '',
    ...entries.map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`)
  ];
  if (record.email) {
    textLines.push('', `Reply to this email to respond directly to ${record.email}.`);
  }

  const rows = entries.map(([k, v]) => {
    const label = escapeHtml(FIELD_LABELS[k] || k);
    const isMessage = k === 'message';
    return `<tr>
      <td style="padding:9px 14px 9px 0;vertical-align:top;color:#6B7D75;font-size:13px;white-space:nowrap;">${label}</td>
      <td style="padding:9px 0;vertical-align:top;color:#0C1A16;font-size:14px;${isMessage ? 'white-space:pre-wrap;' : ''}">${escapeHtml(v)}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#F6F9F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #EAF0ED;border-radius:14px;overflow:hidden;">
    <div style="background:#082A22;padding:20px 24px;">
      <div style="color:#FFFFFF;font-size:17px;font-weight:700;letter-spacing:-0.02em;">
        Solar<span style="color:#FFB94A;">MOT</span>
      </div>
      <div style="color:rgba(255,255,255,.66);font-size:13px;margin-top:3px;">${escapeHtml(type.subject)}</div>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 18px;color:#33473F;font-size:14px;line-height:1.6;">
        A new ${escapeHtml(type.label)} came in from <strong style="color:#0C1A16;">${escapeHtml(who)}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      ${record.email ? `<p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #EAF0ED;color:#6B7D75;font-size:13px;line-height:1.6;">
        Hit reply to respond straight to <a href="mailto:${escapeHtml(record.email)}" style="color:#0E7D53;">${escapeHtml(record.email)}</a>.
      </p>` : ''}
    </div>
  </div>
  <p style="max-width:560px;margin:14px auto 0;color:#94A59D;font-size:12px;text-align:center;">
    Sent automatically by the SolarMOT website. Also saved in Netlify Blobs under <code>${escapeHtml(storeName)}</code>.
  </p>
</body></html>`;

  return { subject, text: textLines.join('\n'), html };
}

/**
 * Best-effort lead notification. Never throws; always resolves to a small
 * status object so the caller can log the outcome without branching on it.
 *
 * @param {string} storeName which form this came from
 * @param {object} record    the stored submission
 * @param {string} [siteUrl] for context in the email body
 */
async function sendLeadNotification(storeName, record, siteUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[notify] RESEND_API_KEY not set — skipping email for ${storeName}/${record.id}. ` +
                `Add it in Netlify > Site configuration > Environment variables to enable notifications.`);
    return { sent: false, skipped: true, reason: 'no-api-key' };
  }

  const to = (process.env.LEAD_NOTIFICATION_TO || DEFAULT_TO)
    .split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.LEAD_NOTIFICATION_FROM || DEFAULT_FROM;
  const { subject, text, html } = buildEmail(storeName, record, siteUrl);

  const payload = { from, to, subject, text, html };
  // Replying to the notification should reach the customer, not us.
  if (record.email) payload.reply_to = record.email;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* non-JSON */ }
      // Logged as an error because someone should notice, but NOT rethrown:
      // the lead is already stored and the visitor must still see success.
      console.error(`[notify] Resend rejected the email for ${storeName}/${record.id}: ` +
                    `${res.status} ${detail}`);
      return { sent: false, skipped: false, reason: `http-${res.status}` };
    }

    const body = await res.json().catch(() => ({}));
    console.log(`[notify] emailed ${to.join(', ')} about ${storeName}/${record.id}` +
                (body.id ? ` (resend id ${body.id})` : ''));
    return { sent: true, id: body.id };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error(`[notify] failed to email about ${storeName}/${record.id}: ` +
                  (aborted ? `timed out after ${SEND_TIMEOUT_MS}ms` : String(err && err.message ? err.message : err)));
    return { sent: false, skipped: false, reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendLeadNotification, buildEmail };
