// POST /api/gocardless-create-billing-request
// Called from signup.html's "Set up Direct Debit" step (js/signup.js).
//
// This is a REAL GoCardless Billing Requests integration, not a mock — but
// it needs a GoCardless API access token to actually talk to GoCardless.
// Add these as Netlify environment variables (Site settings > Environment
// variables) to activate it:
//
//   GOCARDLESS_ACCESS_TOKEN   — your GoCardless API access token
//   GOCARDLESS_ENVIRONMENT    — "sandbox" (default) or "live"
//
// Without GOCARDLESS_ACCESS_TOKEN set, this function returns a clearly
// flagged { mock: true } response so the sign-up flow still works end to
// end for demo purposes.
//
// Flow implemented (per GoCardless Billing Requests docs,
// https://developer.gocardless.com/billing-requests/setting-up-a-dd-mandate/):
//   1. Create a Billing Request with a mandate_request (scheme "bacs", GBP).
//   2. Create a Billing Request Flow against it, prefilling known customer
//      details and setting redirect_uri/exit_uri.
//   3. Return the flow's authorisation_url — the front end redirects the
//      customer there to complete bank authorisation with GoCardless.
//   4. (Not implemented here — needs a GoCardless webhook endpoint) Once
//      the customer authorises, GoCardless sends a webhook confirming the
//      mandate is active. ONLY at that point should the subscription be
//      marked active server-side — never on redirect return alone, since
//      that can be spoofed or abandoned.

const { jsonResponse } = require('./_lib/store');

const GC_API_VERSION = '2015-07-06';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const accessToken = process.env.GOCARDLESS_ACCESS_TOKEN;
  const environment = process.env.GOCARDLESS_ENVIRONMENT === 'live' ? 'live' : 'sandbox';
  const apiBase = environment === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { customer, plan } = data;

  if (!accessToken) {
    return jsonResponse(200, {
      mock: true,
      environment,
      message: 'GOCARDLESS_ACCESS_TOKEN is not set in this environment, so no real GoCardless request was made. Add it in Netlify > Site settings > Environment variables to go live.',
      authorisation_url: null
    });
  }

  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
  const gcHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'GoCardless-Version': GC_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  try {
    // 1. Create the Billing Request
    const brRes = await fetch(`${apiBase}/billing_requests`, {
      method: 'POST',
      headers: gcHeaders,
      body: JSON.stringify({
        billing_requests: {
          mandate_request: { currency: 'GBP', scheme: 'bacs' },
          metadata: plan ? { plan } : undefined
        }
      })
    });
    const br = await brRes.json();
    if (!brRes.ok) {
      return jsonResponse(502, { error: 'GoCardless billing_requests call failed', detail: br });
    }

    // 2. Create the Billing Request Flow, prefilling customer details
    //    captured in step 2 of the sign-up form.
    const flowRes = await fetch(`${apiBase}/billing_request_flows`, {
      method: 'POST',
      headers: gcHeaders,
      body: JSON.stringify({
        billing_request_flows: {
          redirect_uri: `${siteUrl}/signup.html?gc_status=success`,
          exit_uri: `${siteUrl}/signup.html?gc_status=cancelled`,
          lock_customer_details: false,
          links: { billing_request: br.billing_requests.id },
          prefilled_customer: customer ? {
            given_name: customer.firstName,
            family_name: customer.lastName,
            email: customer.email,
            address_line1: customer.address1,
            city: customer.city,
            postal_code: customer.postcode,
            country_code: 'GB'
          } : undefined
        }
      })
    });
    const flow = await flowRes.json();
    if (!flowRes.ok) {
      return jsonResponse(502, { error: 'GoCardless billing_request_flows call failed', detail: flow });
    }

    return jsonResponse(200, {
      mock: false,
      environment,
      billingRequestId: br.billing_requests.id,
      authorisation_url: flow.billing_request_flows.authorisation_url
    });
  } catch (err) {
    return jsonResponse(502, { error: 'GoCardless request failed', detail: String(err) });
  }
};
