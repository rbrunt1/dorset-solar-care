// POST /api/submit-quote
// Used by pricing.html's commercial quote-request form.
const { handleSubmission } = require('./_lib/store');

exports.handler = (event) => handleSubmission(event, {
  storeName: 'commercial-quotes',
  prefix: 'quote',
  required: ['company', 'contact', 'email'],
  build: (data) => ({
    company: data.company,
    contact: data.contact,
    email: data.email,
    phone: data.phone || null,
    postcode: data.postcode || null,
    systemSize: data.systemSize || null,
    serviceLevel: data.serviceLevel || null,
    message: data.message || null
  })
});
