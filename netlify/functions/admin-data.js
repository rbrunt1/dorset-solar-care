// GET  /api/admin-data          -> everything the admin page renders
// POST /api/admin-data          -> mutations: lead status, add/update customer,
//                                  mark a visit complete
//
// All access requires ADMIN_TOKEN. See _lib/auth.js for why this fails closed.

const { jsonResponse, openStore, readAll } = require('./_lib/store');
const { checkAdminAuth } = require('./_lib/auth');
const { checkRateLimit, recordFailure, clearFailures, hasClientHeader } = require('./_lib/ratelimit');
const { withSchedule, dueList, completeVisit, nextDueDate, customerFromLead } = require('./_lib/schedule');

const LEAD_STORES = ['enquiries', 'commercial-quotes', 'bookings', 'interest'];
const CUSTOMER_STORE = 'customers';

async function listAll(event, storeName, limit) {
  const store = openStore(event, storeName);
  const { records, total, truncated } = await readAll(store, { limit, label: storeName });
  return {
    items: records.map(({ key, value }) => ({ ...value, _store: storeName, id: value.id || key })),
    total, truncated
  };
}

exports.handler = async (event) => {
  // Turn away anything that isn't the admin page before doing any work. Most
  // hostile traffic to an endpoint like this is automated scanning that POSTs
  // blindly at every path it finds; none of it sends this header. A targeted
  // attacker will, since the header is in the public JS — this is a filter, not
  // a lock. Its real value is that the failure counters below then reflect
  // genuine attempts rather than background noise.
  if (!hasClientHeader(event)) {
    return jsonResponse(404, { error: 'Not found' });
  }

  // Throttle before checking the password, so a blocked client can't keep
  // guessing. 5 failures per IP, with an escalating block, plus a global cap
  // that catches distributed attempts. A success clears the count, so ordinary
  // use is never affected.
  const limit = await checkRateLimit(openStore, event);
  if (limit.limited) {
    console.warn(`[admin] blocked a client that exceeded the failed sign-in limit (${limit.reason}).`);
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(limit.retryAfterSec) },
      body: JSON.stringify({
        error: `Too many failed sign-in attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.`
      })
    };
  }

  const auth = checkAdminAuth(event);
  if (!auth.ok) {
    // Only a wrong password counts against the limit. A 503 means the site
    // isn't configured yet, which is the owner's problem to fix, not an attack.
    if (auth.status === 401) await recordFailure(openStore, event);
    return jsonResponse(auth.status, { error: auth.error });
  }
  await clearFailures(openStore, event);

  try {
    // --- full backup ------------------------------------------------------
    // Blobs has no snapshot or export. If a store is deleted the customer
    // records are simply gone, so being able to pull everything down as one
    // JSON file is the difference between an inconvenience and a disaster.
    if (event.httpMethod === 'GET' && event.queryStringParameters?.export === '1') {
      const dump = {};
      for (const name of [...LEAD_STORES, CUSTOMER_STORE]) {
        dump[name] = (await listAll(event, name, 10000)).items;
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="solarmot-backup-${new Date().toISOString().slice(0, 10)}.json"`
        },
        body: JSON.stringify({ exportedAt: new Date().toISOString(), data: dump }, null, 2)
      };
    }

    if (event.httpMethod === 'GET') {
      const leadGroups = await Promise.all(LEAD_STORES.map(n => listAll(event, n, 400)));
      const leads = leadGroups.flatMap(g => g.items)
        .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));

      const custResult = await listAll(event, CUSTOMER_STORE, 2000);
      const customers = custResult.items.map(c => withSchedule(c));
      const due = dueList(customers);
      const truncated = leadGroups.some(g => g.truncated) || custResult.truncated;

      return jsonResponse(200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        truncated,
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

        const store = openStore(event, storeName);
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
        const store = openStore(event, CUSTOMER_STORE);
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
        const store = openStore(event, CUSTOMER_STORE);
        const rec = await store.get(id, { type: 'json' });
        if (!rec) return jsonResponse(404, { error: 'Customer not found' });
        const updated = completeVisit(rec, visitDate || new Date());
        await store.setJSON(id, updated);
        return jsonResponse(200, { ok: true, record: withSchedule(updated) });
      }

      // --- turn a won lead into a customer -------------------------------
      // Previously marking a lead "won" did nothing but change a label, so a
      // real customer never reached the visit schedule.
      if (action === 'convert-lead') {
        const { store: storeName, id, plan, startDate } = body;
        if (!LEAD_STORES.includes(storeName)) return jsonResponse(400, { error: 'Unknown store' });
        if (!id) return jsonResponse(400, { error: 'Missing id' });

        const leadStore = openStore(event, storeName);
        const lead = await leadStore.get(id, { type: 'json' });
        if (!lead) return jsonResponse(404, { error: 'Lead not found' });
        if (lead.convertedToCustomer) {
          return jsonResponse(409, { error: 'This lead has already been converted', customerId: lead.convertedToCustomer });
        }

        const customer = customerFromLead({ ...lead, _store: storeName, id },
                                          { plan, startDate, status: 'active' });
        await openStore(event, CUSTOMER_STORE).setJSON(customer.id, customer);
        await leadStore.setJSON(id, {
          ...lead, leadStatus: 'won', leadStatusAt: new Date().toISOString(),
          convertedToCustomer: customer.id
        });
        return jsonResponse(200, { ok: true, record: withSchedule(customer) });
      }

      return jsonResponse(400, { error: `Unknown action: ${action}` });
    }

    return jsonResponse(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin] request failed:', err);
    return jsonResponse(500, { error: 'Admin request failed', detail: String(err.message || err) });
  }
};
