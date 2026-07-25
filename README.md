# Dorset Solar Care — Website + Backend

Marketing + lead-capture + booking + subscription sign-up site for a UK solar panel maintenance subscription business, with a Netlify Functions backend. Deploys as a Netlify site connected to this GitHub repo — push to `main` and Netlify rebuilds automatically.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Marketing home page — value of maintenance, subscription vs one-off comparison, trust strip, CTAs. |
| `pricing.html` | Residential tier cards + comparison table (Essential/Standard/Premium), commercial `£4–£15/kWp/yr` explainer and quote-request form. |
| `contact.html` | General lead-capture enquiry form (name, postcode, email/phone, system size, message). |
| `signup.html` | Residential sign-up flow: **plan → your details → Direct Debit via GoCardless → book first visit → confirmation**. Plan can be pre-selected via `signup.html?plan=essential\|standard\|premium`. |
| `booking.html` | Standalone appointment-request page (for existing subscribers or anyone who wants to pick a slot outside the sign-up flow). |
| `service-area.html` | Postcode-prefix coverage checker (Dorset live now) + Year 2/Year 3 expansion roadmap. |
| `about.html` | Ltd company, insurance, DBS checks, City & Guilds 2377 / 2922-34 certifications, explicit "not an MCS installer" disclaimer. |

Shared front-end assets: `css/styles.css` (design system), `js/main.js` (nav + `submitForm()` helper), `js/booking.js` (date/slot picker widget), `js/signup.js` (sign-up step logic + GoCardless call), `js/postcode-check.js` (coverage checker logic).

## Backend (Netlify Functions)

| Function | Route | Purpose |
|---|---|---|
| `netlify/functions/submit-enquiry.js` | `POST /api/submit-enquiry` | Stores contact-page leads. |
| `netlify/functions/submit-quote.js` | `POST /api/submit-quote` | Stores commercial quote requests. |
| `netlify/functions/submit-booking.js` | `POST /api/submit-booking` | Stores requested appointment slots. |
| `netlify/functions/register-interest.js` | `POST /api/register-interest` | Stores "notify me" sign-ups from the postcode checker on `service-area.html` for people outside the current Dorset coverage area. |
| `netlify/functions/gocardless-create-billing-request.js` | `POST /api/gocardless-create-billing-request` | Real GoCardless Billing Requests integration (see below). |

`/api/*` is redirected to `/.netlify/functions/*` via `netlify.toml`. Submissions are stored with **Netlify Blobs** (`netlify/functions/_lib/store.js`) — a zero-setup key/value store scoped to the site, so there's no separate database to provision for a v1 launch.

If a function isn't deployed/reachable (e.g. you're just opening the HTML files locally), every form and the GoCardless step automatically falls back to a simulated "demo mode" success so the site still works end-to-end for a walkthrough.

### Making GoCardless live

`gocardless-create-billing-request.js` is a real implementation of GoCardless's Billing Requests flow (create a `Billing Request` with a `mandate_request` for `bacs`/GBP → create a `Billing Request Flow` with prefilled customer details → redirect to the returned `authorisation_url`). It's inert until you add these in **Netlify → Site settings → Environment variables**:

- `GOCARDLESS_ACCESS_TOKEN` — your GoCardless API access token (sandbox to start)
- `GOCARDLESS_ENVIRONMENT` — `sandbox` (default) or `live`

Without `GOCARDLESS_ACCESS_TOKEN` set, the function returns `{ mock: true }` and the sign-up flow shows a clearly labelled demo banner instead of redirecting to a real bank authorisation page.

**Still needed for a real launch (not implemented here):**
- A GoCardless **webhook** endpoint to confirm mandate status server-side before marking a subscription active — the redirect back from GoCardless shouldn't be trusted alone.
- Creating the actual `Subscription` (recurring `Payments`) via the GoCardless API once the mandate is confirmed, matching the chosen plan's price.
- Real technician-availability data behind `js/booking.js` (it currently generates plausible-looking slots client-side) and a `GET /api/availability` endpoint to back it.
- A postcode lookup/validation API (e.g. postcodes.io) behind `service-area.html`, replacing the current hardcoded prefix list (`DT`/`BH` = live).
- Outbound notifications (email/SMS/CRM) when a lead, quote, or booking comes in — the functions currently just persist to Netlify Blobs.
- Legal pages: privacy policy, terms, and the GoCardless-required Direct Debit Guarantee text, before accepting real payments.

## Design

Green/blue palette (energy + trust), generous whitespace, system-font stack for fast/reliable rendering with no external font dependency, inline SVG illustrations/icons. Fully responsive down to mobile with a collapsing nav.

## Local development

No build step for the front end. To run the backend locally: `npm install`, then `netlify dev` (requires the Netlify CLI) to serve the site with working `/api/*` functions and Blobs on `localhost`.
