// Shared helper for persisting form submissions using Netlify Blobs.
// Netlify Blobs is a zero-setup key/value store scoped to this site — no
// external database needed for a v1 launch. Each submission is saved as a
// JSON blob keyed by a generated id, under a named "store" (one per form).
const { getStore } = require('@netlify/blobs');

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function saveSubmission(storeName, prefix, payload) {
  const store = getStore(storeName);
  const id = newId(prefix);
  const record = { id, receivedAt: new Date().toISOString(), ...payload };
  await store.setJSON(id, record);
  return record;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

module.exports = { saveSubmission, jsonResponse };
