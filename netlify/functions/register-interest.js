// POST /api/register-interest
// Used by service-area.html's postcode checker — when someone outside the
// current Dorset coverage area checks their postcode, they can register
// their interest inline instead of being pushed off to the contact form.
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

  if (!data.email) {
    return jsonResponse(400, { error: 'Email is required.' });
  }

  try {
    const record = await saveSubmission('interest-registrations', 'interest', {
      name: data.name || null,
      email: data.email,
      postcode: data.postcode || null,
      coverageStatus: data.coverageStatus || null // "soon" (Year 2) or "later" (Year 3+)
    });

    // TODO (real launch): when a new postcode district goes live, query this
    // store for matching registrations and notify them — e.g. a scheduled
    // Netlify Function that batches this into an email send.

    return jsonResponse(200, { ok: true, id: record.id });
  } catch (err) {
    return jsonResponse(500, { error: 'Could not store interest registration', detail: String(err) });
  }
};
