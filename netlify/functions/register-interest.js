// POST /api/register-interest
// Used by service-area.html's postcode checker — when someone outside the
// current Dorset coverage area checks their postcode, they can register
// their interest inline instead of being pushed off to the contact form.
const { handleSubmission } = require('./_lib/store');

exports.handler = (event) => handleSubmission(event, {
  storeName: 'interest-registrations',
  prefix: 'interest',
  required: ['email'],
  build: (data) => ({
    name: data.name || null,
    email: data.email,
    postcode: data.postcode || null,
    coverageStatus: data.coverageStatus || null // "soon" (Year 2) or "later" (Year 3+)
  })
});

// TODO (real launch): when a new postcode district goes live, query this store
// for matching registrations and notify them — e.g. a scheduled Netlify
// Function that batches this into an email send.
