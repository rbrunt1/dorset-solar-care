// POST /api/submit-booking
// Used by booking.html (standalone) and the final step of signup.html.
//
// NOTE: this still records a *requested* slot, not a confirmed one — there's
// no real calendar/technician-availability system behind it yet (see
// README.md). A real launch should replace the client-side slot generator
// in js/booking.js with a call to a real scheduling backend, and this
// function should check the slot is still free before accepting it.
const { saveSubmission, jsonResponse } = require('./_lib/store');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!data.name || !data.email || !data.date || !data.slot) {
    return jsonResponse(400, { error: 'Name, email, date and slot are required.' });
  }

  try {
    const record = await saveSubmission('bookings', 'booking', {
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      postcode: data.postcode || null,
      status: data.status || null, // "existing" subscriber vs "new"
      plan: data.plan || null,
      requestedDate: data.date,
      requestedSlot: data.slot
    });

    return jsonResponse(200, { ok: true, id: record.id });
  } catch (err) {
    return jsonResponse(500, { error: 'Could not store booking request', detail: String(err) });
  }
};
