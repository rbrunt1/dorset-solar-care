// POST /api/submit-enquiry  (redirected to this function via netlify.toml)
// Used by contact.html's general lead-capture form.
const { handleSubmission } = require('./_lib/store');

exports.handler = (event) => handleSubmission(event, {
  storeName: 'enquiries',
  prefix: 'enquiry',
  required: ['name', 'email'],
  build: (data) => ({
    name: data.name,
    postcode: data.postcode || null,
    email: data.email,
    phone: data.phone || null,
    systemSize: data.systemSize || null,
    message: data.message || null
  })
});

// TODO (real launch): notify the ops team when a lead arrives — e.g. send an
// email via Resend or Postmark using an API key stored as a Netlify env var,
// or push into a CRM. Until that exists, new enquiries have to be read out of
// the Blobs store (or the function logs) manually.
