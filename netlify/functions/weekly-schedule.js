// Scheduled weekly: emails the week's visit list.
//
// Schedule is declared in netlify.toml (Mondays 07:00 UTC).
//
// The point of pushing this rather than waiting for someone to open the admin
// page: a maintenance subscription fails quietly. Nobody complains that a visit
// they'd forgotten about didn't happen — they just cancel three months later.
// An unread dashboard doesn't prevent that; an email on a Monday morning does.

const { openStore } = require('./_lib/store');
const { dueList } = require('./_lib/schedule');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function row(c) {
  const overdue = c.scheduleStatus === 'overdue';
  const when = overdue
    ? `${Math.abs(c.daysUntilDue)} day${Math.abs(c.daysUntilDue) === 1 ? '' : 's'} overdue`
    : c.daysUntilDue === 0 ? 'due today' : `in ${c.daysUntilDue} days`;
  return `<tr>
    <td style="padding:10px 8px;border-bottom:1px solid #EAF0ED;">
      <strong style="color:#0C1A16;">${esc(c.name)}</strong><br>
      <span style="color:#6B7D75;font-size:13px;">${esc(c.postcode || '')} ${esc(c.phone ? '· ' + c.phone : '')}</span>
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid #EAF0ED;text-transform:capitalize;">${esc(c.plan)}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #EAF0ED;">${esc(c.nextDue)}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #EAF0ED;color:${overdue ? '#C9453F' : '#0E7D53'};font-weight:600;">${esc(when)}</td>
  </tr>`;
}

exports.handler = async (event) => {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.LEAD_NOTIFICATION_TO || 'robertbrunt@hotmail.co.uk')
    .split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.LEAD_NOTIFICATION_FROM || 'SolarMOT <notifications@solarmot.co.uk>';

  try {
    const store = openStore(event, 'customers');
    const { blobs } = await store.list();
    const customers = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: 'json' });
      if (v) customers.push(v);
    }

    const due = dueList(customers, new Date(), 14);

    // Nothing due is a normal, healthy state — don't send a nagging empty email.
    if (!due.length) {
      console.log('[weekly-schedule] nothing due in the next 14 days; no email sent.');
      return { statusCode: 200, body: JSON.stringify({ ok: true, due: 0, sent: false }) };
    }

    if (!apiKey) {
      console.warn('[weekly-schedule] RESEND_API_KEY not set; skipping send.', { due: due.length });
      return { statusCode: 200, body: JSON.stringify({ ok: true, due: due.length, sent: false }) };
    }

    const overdue = due.filter(c => c.scheduleStatus === 'overdue').length;
    const subject = overdue
      ? `SolarMOT: ${due.length} visit${due.length === 1 ? '' : 's'} due — ${overdue} overdue`
      : `SolarMOT: ${due.length} visit${due.length === 1 ? '' : 's'} due in the next 2 weeks`;

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#06201A;color:#fff;padding:22px 24px;border-radius:14px 14px 0 0;">
        <div style="font-size:19px;font-weight:700;">This week's visits</div>
        <div style="color:rgba(255,255,255,.66);font-size:13px;margin-top:3px;">${esc(subject)}</div>
      </div>
      <div style="border:1px solid #EAF0ED;border-top:none;border-radius:0 0 14px 14px;padding:20px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead><tr style="text-align:left;color:#6B7D75;font-size:12px;text-transform:uppercase;">
            <th style="padding:0 8px 8px;">Customer</th><th style="padding:0 8px 8px;">Plan</th>
            <th style="padding:0 8px 8px;">Due</th><th style="padding:0 8px 8px;">Status</th>
          </tr></thead>
          <tbody>${due.map(row).join('')}</tbody>
        </table>
        <p style="margin:20px 0 0;">
          <a href="https://solarmot.co.uk/admin" style="color:#0E7D53;font-weight:600;">Open the admin dashboard →</a>
        </p>
      </div>
      <p style="color:#94A59D;font-size:12px;margin-top:14px;text-align:center;">
        Sent automatically every Monday by the SolarMOT scheduler.
      </p>
    </div>`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html }),
        signal: controller.signal
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        console.error('[weekly-schedule] Resend rejected the send:', res.status, detail);
        return { statusCode: 200, body: JSON.stringify({ ok: true, due: due.length, sent: false }) };
      }
    } finally {
      clearTimeout(timer);
    }

    console.log(`[weekly-schedule] emailed ${due.length} due visit(s).`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, due: due.length, sent: true }) };
  } catch (err) {
    // Never throw: a failed digest must not show up as a broken scheduled
    // function, and there's nothing a retry would fix.
    console.error('[weekly-schedule] failed:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
