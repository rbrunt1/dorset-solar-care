// POST /api/submit-enquiry  (redirected to this function via netlify.toml)
// Used by contact.html's general lead-capture form.
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

  if (!data.name || !data.email) {
    return jsonResponse(400, { error: 'Name and email are required.' });
  }

  try {
    const record = await saveSubmission('enquiries', 'enquiry', {
      name: data.name,
      postcode: data.postcode || null,
      email: data.email,
      phone: data.phone || null,
      systemSize: data.systemSize || null,
      message: data.message || null
    });

    // TODO (real launch): notify the ops team, e.g. send an email via a
    // provider like Resend or Postmark using an API key stored as a Netlify
    // env var, or push into a CRM. Left out here since it needs a real
    // account/API key that isn't available in this build.

    return jsonResponse(200, { ok: true, id: record.id });
  } catch (err) {
    return jsonResponse(500, { error: 'Could not store enquiry', detail: String(err) });
  }
};
