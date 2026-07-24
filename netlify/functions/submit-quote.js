// POST /api/submit-quote
// Used by pricing.html's commercial quote-request form.
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

  if (!data.company || !data.contact || !data.email) {
    return jsonResponse(400, { error: 'Company, contact name and email are required.' });
  }

  try {
    const record = await saveSubmission('commercial-quotes', 'quote', {
      company: data.company,
      contact: data.contact,
      email: data.email,
      phone: data.phone || null,
      postcode: data.postcode || null,
      systemSize: data.systemSize || null,
      serviceLevel: data.serviceLevel || null,
      message: data.message || null
    });

    return jsonResponse(200, { ok: true, id: record.id });
  } catch (err) {
    return jsonResponse(500, { error: 'Could not store quote request', detail: String(err) });
  }
};
