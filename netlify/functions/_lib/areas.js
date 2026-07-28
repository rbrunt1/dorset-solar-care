// Area-expansion: grouping the waiting list, and telling them when you arrive.
//
// The riskiest thing in this codebase. Every other email goes to one person who
// just pressed a button on the website. This one goes to a list of people, some
// of whom registered months ago, and it cannot be unsent.
//
// So the design is built around three rules:
//
//  1. NOTHING SENDS WITHOUT A PREVIEW. The caller must first ask who matches,
//     see the count and the addresses, and then confirm. There is no single
//     call that both selects recipients and emails them.
//  2. NOBODY IS TOLD TWICE. Each record is marked the moment it is sent, and
//     already-notified records are excluded from future runs. A double-clicked
//     button, a retried request or a second expansion into an overlapping area
//     must not re-mail the same person.
//  3. IT SAYS ONLY WHAT WAS PROMISED. The acknowledgement these people received
//     said "we won't email you about anything else". This tells them their area
//     is covered and nothing more — no offers, no newsletter. That promise is
//     also what makes this a solicited message they asked for rather than
//     marketing, so keeping to it matters beyond good manners.

const CONTACT_PHONE = '07891 110865';
const CONTACT_EMAIL = 'hello@solarmot.co.uk';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 5000;
const DEFAULT_FROM = 'SolarMOT <hello@solarmot.co.uk>';

// Send in small batches with a pause between, so a long list neither trips
// Resend's rate limit nor runs past the function timeout.
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 1100;

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The outward postcode district letters — 'SO' from 'SO16 4GX'.
 * Returns '' for anything unusable rather than guessing.
 */
function areaPrefix(postcode) {
  if (!postcode) return '';
  const m = String(postcode).trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  return m ? m[1] : '';
}

/**
 * Group the waiting list by area, most demand first.
 *
 * This is useful before any sending: it turns a flat list of registrations into
 * an answer to "where should we expand next?".
 */
function groupByArea(registrations) {
  const groups = new Map();
  for (const r of registrations) {
    const prefix = areaPrefix(r.postcode) || 'Unknown';
    if (!groups.has(prefix)) {
      groups.set(prefix, { prefix, total: 0, waiting: 0, notified: 0, people: [] });
    }
    const g = groups.get(prefix);
    g.total += 1;
    if (r.notifiedAt) g.notified += 1; else g.waiting += 1;
    g.people.push({
      id: r.id, name: r.name || null, email: r.email,
      postcode: r.postcode || null,
      registeredAt: r.receivedAt || null,
      notifiedAt: r.notifiedAt || null
    });
  }
  return [...groups.values()].sort((a, b) => b.waiting - a.waiting || b.total - a.total);
}

/**
 * Who would be emailed for this area, and who would be skipped and why.
 * Pure — no sending, no writes. This is what the preview screen renders.
 */
function selectRecipients(registrations, prefix) {
  const target = String(prefix || '').trim().toUpperCase();
  const willSend = [];
  const skipped = [];

  for (const r of registrations) {
    if (areaPrefix(r.postcode) !== target) continue;
    if (r.notifiedAt) {
      skipped.push({ id: r.id, email: r.email, reason: 'already notified' });
    } else if (!r.email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(r.email).trim())) {
      skipped.push({ id: r.id, email: r.email || null, reason: 'no usable email address' });
    } else {
      willSend.push(r);
    }
  }
  return { prefix: target, willSend, skipped };
}

function buildAreaEmail(record, prefix) {
  const firstName = String(record.name || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  const text = [
    greeting,
    '',
    `A while ago you asked us to let you know when SolarMOT covered ${prefix}. We do now.`,
    '',
    'You can check the plans and sign up here:',
    'https://solarmot.co.uk/pricing',
    '',
    `Any questions, just reply to this or call ${CONTACT_PHONE}.`,
    '',
    'Rob',
    'SolarMOT',
    CONTACT_EMAIL,
    '',
    '—',
    `You're getting this one email because you asked to be told when we covered ${prefix}.`,
    "That's the only reason we've contacted you. Reply with \"no thanks\" and I'll remove you."
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F6F8F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;">
    <p style="margin:0 0 14px;color:#0C1A16;font-size:15px;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 18px;color:#0C1A16;font-size:15px;line-height:1.55;">
      A while ago you asked us to let you know when SolarMOT covered
      <strong>${escapeHtml(prefix)}</strong>. We do now.
    </p>
    <p style="margin:0 0 22px;">
      <a href="https://solarmot.co.uk/pricing" style="display:inline-block;background:#0E7D53;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-size:15px;">See the plans</a>
    </p>
    <p style="margin:0 0 18px;color:#0C1A16;font-size:15px;line-height:1.55;">
      Any questions, just reply to this or call
      <a href="tel:+447891110865" style="color:#0E7D53;">${escapeHtml(CONTACT_PHONE)}</a>.
    </p>
    <p style="margin:0;color:#0C1A16;font-size:15px;line-height:1.55;">
      Rob<br><span style="color:#5B6B66;">SolarMOT</span>
    </p>
    <p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #E6EBE9;color:#8A9691;font-size:12px;line-height:1.5;">
      You're getting this one email because you asked to be told when we covered
      ${escapeHtml(prefix)}. That's the only reason we've contacted you.
      Reply with &ldquo;no thanks&rdquo; and I'll remove you.
    </p>
  </div>
</body></html>`;

  return { subject: `We now cover ${prefix} — SolarMOT`, text, html };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Email one recipient. Never throws.
 */
async function sendOne(record, prefix, apiKey) {
  const built = buildAreaEmail(record, prefix);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ACKNOWLEDGEMENT_FROM || DEFAULT_FROM,
        to: [String(record.email).trim()],
        reply_to: CONTACT_EMAIL,
        subject: built.subject, text: built.text, html: built.html
      }),
      signal: controller.signal
    });
    if (!res.ok) return { sent: false, reason: `http-${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the area announcement.
 *
 * Marks each record IMMEDIATELY after its own send succeeds, rather than
 * marking the whole batch at the end. If the function times out or crashes
 * half way, the people already emailed are already recorded as emailed — so a
 * re-run continues rather than starting over and mailing them twice.
 *
 * @param {object} deps  { store, apiKey } — store injected so this is testable
 */
async function notifyArea(deps, registrations, prefix) {
  const { store, apiKey } = deps;
  const { willSend, skipped } = selectRecipients(registrations, prefix);
  const target = String(prefix).trim().toUpperCase();

  const sent = [];
  const failed = [];

  for (let i = 0; i < willSend.length; i += BATCH_SIZE) {
    const batch = willSend.slice(i, i + BATCH_SIZE);

    for (const record of batch) {
      const result = await sendOne(record, target, apiKey);
      if (!result.sent) {
        failed.push({ id: record.id, email: record.email, reason: result.reason });
        continue;
      }
      // Mark before moving on. A crash after this point is safe; a crash
      // before it means this person is retried, which is the right way round.
      try {
        await store.setJSON(record.id, {
          ...record,
          notifiedAt: new Date().toISOString(),
          notifiedForArea: target
        });
        sent.push({ id: record.id, email: record.email });
      } catch (err) {
        // Emailed but not recorded — the one case that could double-send on a
        // re-run, so it is reported loudly rather than counted as a success.
        failed.push({
          id: record.id, email: record.email,
          reason: 'sent but could not be marked as notified — re-running may email them twice'
        });
      }
    }

    if (i + BATCH_SIZE < willSend.length) await sleep(BATCH_PAUSE_MS);
  }

  return { prefix: target, sent, failed, skipped };
}

module.exports = {
  areaPrefix, groupByArea, selectRecipients, buildAreaEmail, notifyArea,
  BATCH_SIZE, CONTACT_PHONE, CONTACT_EMAIL
};
