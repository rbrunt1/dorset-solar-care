// GET  /api/admin-data          -> everything the admin page renders
// POST /api/admin-data          -> mutations: lead status, add/update customer,
//                                  mark a visit complete
//
// All access requires ADMIN_TOKEN. See _lib/auth.js for why this fails closed.

const { connectLambda, getStore } = require('@netlify/blobs');
const { jsonResponse } = require('./_lib/store');
const { checkAdminAuth } = require('./_lib/auth');
const { withSchedule, dueList, completeVisit, nextDueDate } = require('./_lib/schedule');

const LEAD_STORES = ['enquiries', 'commercial-quotes', 'bookings', 'interest'];
const CUSTOMER_STORE = 'customers';

async function listAll(storeName) {
  const store = getStore(storeName);
  const { blobs } = await store.list();
  const out = [];
  for (const b of blobs) {
    try {
      const v = await store.get(b.key, { type: 'json' });
      if (v) out.push({ ...v, _store: storeName, id: v.id || b.key });
    } catch (err) {
      // One unreadable blob must not blank the whole dashboard.
      console.error(`[admin] could not read ${storeName}/${b.key}:`, err.message);
    }
  }
  return out;
}

exports.handler = async (event) => {
  const auth = checkAdminAuth(event);
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });

  connectLambda(event);

  try {
    if (event.httpMethod === 'GET') {
      const leadGroups = await Promise.all(LEAD_STORES.map(listAll));
      const leads = leadGroups.flat()
        .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));

      const customers = (await listAll(CUSTOMER_STORE)).map(c => withSchedule(c));
      const due = dueList(customers);

      return jsonResponse(200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        counts: {
          leads: leads.length,
          newLeads: leads.filter(l => !l.leadStatus || l.leadStatus === 'new').length,
          customers: customers.filter(c => c.status !== 'cancelled').length,
          due: due.length,
          overdue: due.filter(c => c.scheduleStatus === 'overdue').length
        },
        leads, customers, due
      });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

      const { action } = body;

      // --- move a lead through the pipeline -----------------------------
      if (action === 'set-lead-status') {
        const { store: storeName, id, leadStatus } = body;
        if (!LEAD_STORES.includes(storeName)) return jsonResponse(400, { error: 'Unknown store' });
        if (!id) return jsonResponse(400, { error: 'Missing id' });
        const allowed = ['new', 'contacted', 'quoted', 'won', 'lost'];
        if (!allowed.includes(leadStatus)) return jsonResponse(400, { error: 'Invalid status' });

        const store = getStore(storeName);
        const rec = await store.get(id, { type: 'json' });
        if (!rec) return jsonResponse(404, { error: 'Lead not found' });
        const updated = { ...rec, leadStatus, leadStatusAt: new Date().toISOString() };
        await store.setJSON(id, updated);
        return jsonResponse(200, { ok: true, record: updated });
      }

      // --- create or update a customer ----------------------------------
      if (action === 'save-customer') {
        const { customer } = body;
        if (!customer || !customer.name || !customer.plan) {
          return jsonResponse(400, { error: 'Customer needs at least a name and a plan' });
        }
        const store = getStore(CUSTOMER_STORE);
        const id = customer.id || `cust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startDate = customer.startDate || new Date().toISOString().slice(0, 10);
        const record = {
          status: 'active',
          ...customer,
          id, startDate,
          updatedAt: new Date().toISOString()
        };
        record.nextDue = customer.nextDue || nextDueDate(record);
        await store.setJSON(id, record);
        return jsonResponse(200, { ok: true, record: withSchedule(record) });
      }

      // --- mark a visit done, roll the schedule forward ------------------
      if (action === 'complete-visit') {
        const { id, visitDate } = body;
        if (!id) return jsonResponse(400, { error: 'Missing id' });
        const store = getStore(CUSTOMER_STORE);
        const rec = await store.get(id, { type: 'json' });
        if (!rec) return jsonResponse(404, { error: 'Customer not found' });
        const updated = completeVisit(rec, visitDate || new Date());
        await store.setJSON(id, updated);
        return jsonResponse(200, { ok: true, record: withSchedule(updated) });
      }

      return jsonResponse(400, { error: `Unknown action: ${action}` });
    }

    return jsonResponse(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin] request failed:', err);
    return jsonResponse(500, { error: 'Admin request failed', detail: String(err.message || err) });
  }
};
