// POST /api/submit-booking
// Used by booking.html (standalone) and the final step of signup.html.
//
// NOTE: this records a *requested* slot, not a confirmed one — there's no real
// calendar/technician-availability system behind it yet (see README.md). A real
// launch should replace the client-side slot generator in js/booking.js with a
// call to a real scheduling backend, and this function should check the slot is
// still free before accepting it. The site copy is written to match: visitors
// are told slots are a preference that gets confirmed separately.
const { handleSubmission } = require('./_lib/store');

exports.handler = (event) => handleSubmission(event, {
  storeName: 'bookings',
  prefix: 'booking',
  required: ['name', 'email', 'date', 'slot'],
  build: (data) => ({
    name: data.name,
    email: data.email,
    phone: data.phone || null,
    postcode: data.postcode || null,
    status: data.status || null, // "existing" subscriber vs "new"
    plan: data.plan || null,
    requestedDate: data.date,
    requestedSlot: data.slot
  })
});
