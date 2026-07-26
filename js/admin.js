/**
 * Admin dashboard.
 *
 * The token lives in sessionStorage, not localStorage: it dies with the tab,
 * so a shared or forgotten browser doesn't leave standing access to customer
 * records. Nothing is rendered from page source — every value comes from the
 * authenticated endpoint, so viewing source reveals nothing.
 */

const TOKEN_KEY = 'solarmot:admin-token';
let DATA = null;

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem(TOKEN_KEY) || '';

/** Escape everything before it reaches innerHTML. Customer-supplied strings
 *  (names, messages) end up in this table, and an admin page is exactly where
 *  a stored-XSS payload would be most damaging. */
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function api(method, body) {
  const res = await fetch('/api/admin-data', {
    method,
    headers: {
      'Authorization': `Bearer ${token()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) {
    const err = new Error(payload.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

const STORE_LABELS = {
  enquiries: 'Enquiry',
  'commercial-quotes': 'Commercial quote',
  bookings: 'Booking request',
  interest: 'Area interest'
};
const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function sourceText(s) {
  if (!s) return '—';
  if (s.utmSource || s.utmMedium) {
    return [s.utmSource, s.utmMedium].filter(Boolean).join(' / ') + (s.utmCampaign ? ` — ${s.utmCampaign}` : '');
  }
  if (s.referrer && s.referrer !== 'direct') {
    try { return new URL(s.referrer).hostname.replace(/^www\./, ''); } catch { return s.referrer; }
  }
  if (s.referrer === 'direct') return 'Direct';
  return '—';
}

function renderCounts(c) {
  $('admin-counts').innerHTML = [
    ['New leads', c.newLeads, c.newLeads > 0 ? 'amber' : ''],
    ['Total leads', c.leads, ''],
    ['Active customers', c.customers, ''],
    ['Visits due', c.due, ''],
    ['Overdue', c.overdue, c.overdue > 0 ? 'red' : '']
  ].map(([label, n, tone]) =>
    `<div class="admin-stat ${tone}"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`
  ).join('');
}

function renderDue(due) {
  const tbody = $('due-rows');
  $('due-empty').style.display = due.length ? 'none' : 'block';
  tbody.innerHTML = due.map(c => {
    const overdue = c.scheduleStatus === 'overdue';
    const when = overdue
      ? `${Math.abs(c.daysUntilDue)} day${Math.abs(c.daysUntilDue) === 1 ? '' : 's'} overdue`
      : c.daysUntilDue === 0 ? 'Due today' : `In ${c.daysUntilDue} days`;
    return `<tr>
      <td><strong>${esc(c.name)}</strong><div class="text-muted text-xs">${esc(c.postcode || '')}${c.phone ? ' · ' + esc(c.phone) : ''}</div></td>
      <td style="text-transform:capitalize;">${esc(c.plan)}</td>
      <td>${fmtDate(c.nextDue)}</td>
      <td class="${overdue ? 'no' : 'yes'}">${esc(when)}</td>
      <td><button class="btn btn-secondary btn-sm" data-complete="${esc(c.id)}">Mark visited</button></td>
    </tr>`;
  }).join('');
}

function renderLeads(leads) {
  const tbody = $('lead-rows');
  $('leads-empty').style.display = leads.length ? 'none' : 'block';
  tbody.innerHTML = leads.map(l => {
    const name = l.name || l.contact || l.company || '—';
    const contact = [l.email, l.phone].filter(Boolean).join('<br>') || '—';
    const status = l.leadStatus || 'new';
    const opts = LEAD_STATUSES.map(s =>
      `<option value="${s}"${s === status ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('');
    const converted = !!l.convertedToCustomer;
    return `<tr>
      <td class="text-xs">${fmtDate(l.receivedAt)}</td>
      <td><strong>${esc(name)}</strong>${l.postcode ? `<div class="text-muted text-xs">${esc(l.postcode)}</div>` : ''}</td>
      <td class="text-xs">${contact}</td>
      <td class="text-xs">${esc(STORE_LABELS[l._store] || l._store)}</td>
      <td class="text-xs">${esc(sourceText(l.source))}</td>
      <td><select class="admin-select" data-lead-store="${esc(l._store)}" data-lead-id="${esc(l.id)}">${opts}</select></td>
      <td>${converted
        ? '<span class="text-muted text-xs">Customer created</span>'
        : `<button class="btn btn-secondary btn-sm" data-convert-store="${esc(l._store)}" data-convert-id="${esc(l.id)}">Make customer</button>`}</td>
    </tr>`;
  }).join('');
}

function renderCustomers(customers) {
  $('customer-rows').innerHTML = customers.map(c => `<tr>
    <td><strong>${esc(c.name)}</strong><div class="text-muted text-xs">${esc(c.email || '')}</div></td>
    <td style="text-transform:capitalize;">${esc(c.plan)}</td>
    <td>${fmtDate(c.startDate)}</td>
    <td>${c.lastVisit ? fmtDate(c.lastVisit) : '<span class="text-muted">Never</span>'}</td>
    <td>${fmtDate(c.nextDue)}</td>
    <td>${esc(c.visitsCompleted || 0)}</td>
  </tr>`).join('');
}

function render(data) {
  DATA = data;
  const t = $('admin-truncated');
  if (t) t.style.display = data.truncated ? 'block' : 'none';
  renderCounts(data.counts);
  renderDue(data.due);
  renderLeads(data.leads);
  renderCustomers(data.customers);
  $('admin-generated').textContent = 'Updated ' + new Date(data.generatedAt)
    .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

async function load() {
  try {
    render(await api('GET'));
    $('admin-gate').style.display = 'none';
    $('admin-app').hidden = false;
  } catch (err) {
    if (err.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      showGate(err.message);
    } else {
      showGate(err.message);
    }
  }
}

function showGate(message) {
  $('admin-app').hidden = true;
  $('admin-gate').style.display = 'block';
  const box = $('admin-login-error');
  if (message) { box.textContent = message; box.style.display = 'block'; }
  else { box.style.display = 'none'; }
}

document.addEventListener('DOMContentLoaded', () => {
  $('c-start').value = new Date().toISOString().slice(0, 10);

  $('admin-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    sessionStorage.setItem(TOKEN_KEY, $('admin-token').value.trim());
    $('admin-token').value = '';
    await load();
  });

  $('admin-refresh').addEventListener('click', load);
  $('admin-signout').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    showGate('');
  });

  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.admin-panel').forEach(p =>
        p.classList.toggle('is-active', p.dataset.panel === btn.dataset.tab));
    });
  });

  // Lead status changes
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('.admin-select');
    if (!sel) return;
    sel.disabled = true;
    try {
      await api('POST', {
        action: 'set-lead-status',
        store: sel.dataset.leadStore,
        id: sel.dataset.leadId,
        leadStatus: sel.value
      });
      await load();
    } catch (err) {
      alert('Could not update: ' + err.message);
    } finally {
      sel.disabled = false;
    }
  });

  // Convert a lead into a customer — previously "won" only changed a label,
  // so the customer never reached the visit schedule at all.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-convert-id]');
    if (!btn) return;
    const plan = prompt('Which plan? essential / standard / premium', 'standard');
    if (!plan) return;
    btn.disabled = true;
    try {
      await api('POST', {
        action: 'convert-lead',
        store: btn.dataset.convertStore,
        id: btn.dataset.convertId,
        plan: plan.trim().toLowerCase()
      });
      await load();
    } catch (err) {
      alert('Could not convert: ' + err.message);
      btn.disabled = false;
    }
  });

  // Download a full JSON backup. Blobs has no export, so this is the only
  // way to get customer records off the platform.
  $('admin-backup').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin-data?export=1', {
        headers: { Authorization: `Bearer ${token()}` }
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `solarmot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(err.message);
    }
  });

  // Mark a visit complete
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-complete]');
    if (!btn) return;
    if (!confirm('Mark this visit as completed today? The next visit will be scheduled automatically.')) return;
    btn.disabled = true;
    try {
      await api('POST', { action: 'complete-visit', id: btn.dataset.complete });
      await load();
    } catch (err) {
      alert('Could not save: ' + err.message);
      btn.disabled = false;
    }
  });

  // Add a customer
  $('customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('customer-error');
    box.style.display = 'none';
    try {
      await api('POST', {
        action: 'save-customer',
        customer: {
          name: $('c-name').value.trim(),
          plan: $('c-plan').value,
          email: $('c-email').value.trim(),
          phone: $('c-phone').value.trim(),
          postcode: $('c-postcode').value.trim(),
          startDate: $('c-start').value
        }
      });
      e.target.reset();
      $('c-start').value = new Date().toISOString().slice(0, 10);
      await load();
    } catch (err) {
      box.textContent = err.message;
      box.style.display = 'block';
    }
  });

  if (token()) load(); else showGate('');
});
