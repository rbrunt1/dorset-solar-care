# SolarMOT — Website + Backend

Marketing + lead-capture + booking + subscription sign-up site for **SolarMOT**, a UK solar panel maintenance subscription business ("an MOT for your solar panels"), with a Netlify Functions backend. Deploys as a Netlify site connected to this GitHub repo — push to `main` and Netlify rebuilds automatically.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Marketing home page — value of maintenance, subscription vs one-off comparison, trust strip, CTAs. |
| `pricing.html` | Residential tier cards + comparison table (Essential/Standard/Premium), commercial `£4–£15/kWp/yr` explainer and quote-request form. |
| `contact.html` | General lead-capture enquiry form (name, postcode, email/phone, system size, message). |
| `signup.html` | Residential sign-up flow: **plan → your details → Direct Debit via GoCardless → book first visit → confirmation**. Plan can be pre-selected via `signup.html?plan=essential\|standard\|premium`. |
| `booking.html` | Standalone appointment-request page (for existing subscribers or anyone who wants to pick a slot outside the sign-up flow). |
| `service-area.html` | Postcode-prefix coverage checker (Dorset live now) + Year 2/Year 3 expansion roadmap. |
| `about.html` | Ltd company, insurance, City & Guilds 2377 / 2922-34 certifications, explicit "not an MCS installer" disclaimer. |

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

### Gotcha: `connectLambda()` is required

These functions use the Lambda-compatible signature (`exports.handler = async (event) => ...`). **In that mode Netlify does not auto-configure the Blobs environment**, so calling `getStore()` on its own throws `MissingBlobsEnvironmentError` in production. Netlify injects the credentials on `event.blobs`, and `connectLambda(event)` reads them — it must be called inside the handler, immediately before `getStore()`.

This is easy to miss because **it works fine under `netlify dev`** and only fails once deployed. `npm test` has a dedicated test asserting `connectLambda` is called, so the bug can't come back silently.

### Failure behaviour

A storage failure returns **500, never 200**. The front end (`submitForm()` in `js/main.js`) treats that as a failure and shows the visitor an error with an email/phone fallback, rather than a success screen for a lead that was never saved. Submissions are also `console.log`ged before the write is attempted, so if a write does fail the lead is still recoverable from the function logs in the Netlify dashboard.

The signup flow does the same but more carefully: by the final step the customer may already have authorised a real Direct Debit mandate, so a failed booking write doesn't block them — they reach the confirmation screen, but it states plainly that the visit slot wasn't recorded and how to get it booked.

## Lead notification emails

Every successful submission emails the business owner, via **Resend** (`netlify/functions/_lib/notify.js`). Resend was chosen over Postmark purely on fit: it's a single authenticated HTTPS POST so nothing is added to the function bundle, and its free tier is 3,000 emails/month against Postmark's 100.

The email lists every submitted field, translates raw values into readable ones (e.g. `coverageStatus: "soon"` becomes "Year 2 area"), omits empty optional fields rather than showing blanks, escapes all user input, and sets `reply_to` to the customer's address so replying goes straight to them.

### Enabling it

One environment variable, in **Netlify → Site configuration → Environment variables**:

| Variable | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | yes | From <https://resend.com/api-keys>. |
| `LEAD_NOTIFICATION_TO` | no | Comma-separated recipients. Defaults to `robertbrunt@hotmail.co.uk`. |
| `LEAD_NOTIFICATION_FROM` | no | Must be on a domain verified in Resend. Defaults to `SolarMOT <notifications@solarmot.co.uk>`. |

### Current live configuration

`RESEND_API_KEY` and `LEAD_NOTIFICATION_FROM` are both set in Netlify. Notifications are working and verified delivered.

`LEAD_NOTIFICATION_FROM` is currently `SolarMOT <onboarding@resend.dev>` — Resend's shared sandbox sender. **Two limitations while it stays that way:** it can only deliver to the Resend account's own address (robertbrunt@hotmail.co.uk), so extra recipients won't work, and the emails come from a `resend.dev` address rather than the brand.

To switch to branded sending, `solarmot.co.uk` needs verifying in Resend. All required records now exist at Namecheap:

| Type | Host | Value | Status |
|---|---|---|---|
| TXT | `resend._domainkey` | DKIM public key | done |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | done |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | done |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | optional, not added |

Once Resend shows the domain Verified, change `LEAD_NOTIFICATION_FROM` to `SolarMOT <notifications@solarmot.co.uk>` and redeploy.

### Incoming mail: hello@solarmot.co.uk

`hello@solarmot.co.uk` is a real mailbox on **Namecheap Private Email** (Launch plan, 5 GB). Not a forwarder — it sends as well as receives.

The DNS this depends on. Namecheap's **Mail Settings** is a single mode, so it is set to **Custom MX** rather than "Private Email": that mode auto-fills the two apex MX records but does not allow an MX on any other host, and Resend needs one on `send`. Custom MX takes arbitrary hosts, so both fit:

| Type | Host | Value | Priority |
|---|---|---|---|
| MX | `@` | `mx1.privateemail.com` | 10 |
| MX | `@` | `mx2.privateemail.com` | 10 |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| TXT | `@` | `v=spf1 include:spf.privateemail.com ~all` | — |
| TXT | `privateemail._domainkey` | DKIM public key | — |

If Mail Settings is ever switched back to "Private Email" or "Email Forwarding", the `send` MX disappears and Resend silently un-verifies. Leave it on Custom MX.

The earlier free forwarder (`hello` → `robertbrunt@hotmail.co.uk`, under Domain tab → Redirect Email) is now inert, since the apex MX no longer points at `eforward*.registrar-servers.com`.

To add the mailbox to a mail client: server `mail.privateemail.com` for both directions, IMAP 993 (SSL) or 143 (STARTTLS), SMTP 465 (SSL) or 587 (STARTTLS), username is the full address, SMTP authentication on, SPA off.

**Without `RESEND_API_KEY` the notifier cleanly no-ops** — it logs that it skipped and the submission still succeeds. Nothing breaks before the key exists.

### Notifications must never cost a lead

By the time the notifier runs, the record is already stored. So every failure path is swallowed and logged, and the response is still `200`: a Resend outage, an unverified domain, a bad recipient or a hung request must not turn a saved lead into an error for the visitor. There's also a 5-second timeout so a hanging email API can't consume the function's execution budget.

This is enforced by tests, not just intent — including a check that a storage failure sends *no* email (never notify about a lead that wasn't saved). The guarantee was verified by mutation: making failures escape the notifier breaks two tests.

## Tests

`npm test` runs `node --test` against `tests/functions.test.js`. The tests live outside `netlify/functions/` deliberately, so Netlify cannot mistake them for a deployable function. It stubs out `@netlify/blobs` and `fetch`, so it needs no Netlify account, no Resend account and no network. 22 tests covering:

- `connectLambda` being called with the event before `getStore` (the original production bug)
- storage failures returning 500, never a false success
- field validation, whitespace-only values, method and JSON-body rejection
- the stored shape of each of the four form types
- notification content: subject per form type, readable values, escaped HTML, omitted empty fields, `reply_to` set to the customer
- **and the important one:** email HTTP errors, network failures, hangs and a missing API key all still return 200 with the lead stored

If you open the HTML files directly from disk (`file://`), forms fall back to a simulated success so the flow can still be walked through with no backend. That fallback is **deliberately limited to `file://`** — on a real http(s) origin a failure always surfaces as a visible error, never a fake success.

### Making GoCardless live

`gocardless-create-billing-request.js` is a real implementation of GoCardless's Billing Requests flow (create a `Billing Request` with a `mandate_request` for `bacs`/GBP → create a `Billing Request Flow` with prefilled customer details → redirect to the returned `authorisation_url`). It's inert until you add these in **Netlify → Site settings → Environment variables**:

- `GOCARDLESS_ACCESS_TOKEN` — your GoCardless API access token (sandbox to start)
- `GOCARDLESS_ENVIRONMENT` — `sandbox` (default) or `live`
- `ADMIN_TOKEN` — the password for /admin. Minimum 12 characters. Production
  context only: leaving the other deploy contexts empty means the dashboard
  returns 503 on preview and branch URLs rather than accepting the live
  password there.

  Four layers protect it, since it has no username to guess and no account
  lockout:

  1. **A required client header.** The admin page sends `X-SolarMOT-Client`;
     requests without it get a 404 before the password is read. This is a
     filter, not a lock — the header name is in the public JS, so a targeted
     attacker will send it. What it does is turn away automated scanners, which
     are the overwhelming majority of hostile traffic, and keep the failure
     counters meaningful.
  2. **5 failed sign-ins per IP** per 15-minute window.
  3. **Escalating blocks** — 15 minutes, then an hour, then six. A mistyped
     password costs you a quarter of an hour; a script gets frozen out.
  4. **A global cap of 40 failures/hour across all IPs.** Layers 2 and 3 are
     per-IP, so a botnet with a thousand addresses would sail past them. This
     catches that shape of attack.

  A successful sign-in clears your counter, so normal use is never throttled.
  Everything fails OPEN if Blobs is unavailable — deliberately, so a storage
  outage can't lock you out of your own customer records. The password check
  still runs regardless.

  Environment variable changes do not reach already-built functions. After
  changing this, trigger a redeploy or it will appear not to have worked.

- `NETLIFY_API_TOKEN` — a Netlify personal access token. Required **only** for the
  weekly scheduled digest: scheduled functions are invoked with a synthetic event
  that carries no Blobs credentials, so without this the digest silently never
  arrives. Request-triggered functions do not need it.

Without `GOCARDLESS_ACCESS_TOKEN` set, the function returns `{ mock: true }` and the sign-up flow shows a clearly labelled demo banner instead of redirecting to a real bank authorisation page.
- `GOCARDLESS_WEBHOOK_SECRET` — the signing secret shown when you create the webhook endpoint in GoCardless

### Why the webhook is not optional

A Direct Debit **mandate** is only permission to collect money. It does not
collect anything. Creating a mandate and stopping there — which is what the
sign-up flow did on its own — means a customer completes sign-up, sees a
success screen, and is never charged a penny.

`gocardless-webhook.js` closes that loop: when GoCardless confirms the mandate
is active, it creates the recurring monthly **subscription** at the plan price
and writes the customer into the visit schedule.

Set it up in the GoCardless dashboard under Developers → Webhook endpoints:

- URL: `https://solarmot.co.uk/api/gocardless-webhook`
- Copy the signing secret into `GOCARDLESS_WEBHOOK_SECRET` in Netlify

Every request is verified by HMAC-SHA256 over the raw body. If the secret is
unset the endpoint returns 503 rather than trusting the request — an
unverified webhook would let anyone who finds the URL activate a free
subscription. Subscription creation is idempotent on the mandate id, because
GoCardless retries and a duplicate would bill the customer twice a month
indefinitely.

Customer status is only ever set from a verified webhook, never from the
browser redirect — anyone can type `?gc_status=success` into the address bar.


**Still needed for a real launch (not implemented here):**
- A GoCardless **webhook** endpoint to confirm mandate status server-side before marking a subscription active — the redirect back from GoCardless shouldn't be trusted alone.
- Creating the actual `Subscription` (recurring `Payments`) via the GoCardless API once the mandate is confirmed, matching the chosen plan's price.
- Real technician-availability data behind `js/booking.js` (it currently generates plausible-looking slots client-side) and a `GET /api/availability` endpoint to back it.
- A postcode lookup/validation API (e.g. postcodes.io) behind `service-area.html`, replacing the current hardcoded prefix list (`DT`/`BH` = live).
- Legal pages: privacy policy, terms, and the GoCardless-required Direct Debit Guarantee text, before accepting real payments.

## Domains

- **solarmot.co.uk** — canonical live site (Netlify ALIAS → `apex-loadbalancer.netlify.com`, `www` CNAME → the Netlify subdomain).
- **solarmot.com** and **www.solarmot.com** — added as Netlify domain aliases, so Netlify issues Let's Encrypt certificates for them and redirects both to the primary domain. This replaced Namecheap URL-redirect records, which cannot serve HTTPS (`https://www.solarmot.com` produced a certificate error).

  For the aliases to verify, the `.com` DNS at Namecheap must be:

  | Type | Host | Value |
  |---|---|---|
  | ALIAS | `@` | `apex-loadbalancer.netlify.com` |
  | CNAME | `www` | `dynamic-figolla-971e47.netlify.app` |

  (If ALIAS is unavailable, an A record on `@` to `75.2.60.5` works instead.) The old `URL Redirect Record` entries for `@` and `www` must be removed, since they conflict.

## Design

**Brand idea:** the site leans on the MOT metaphor — a documented, qualified, once-a-year-minimum inspection with a clear pass. The homepage hero centrepiece is a styled "Solar MOT report" card, and the inspection checklist is treated as a first-class piece of content. A visible disclaimer states that "MOT" is descriptive shorthand and not a statutory test, alongside the existing not-an-MCS-installer disclaimer.

**System:** deep forest-green/teal base for hero, dark bands and footer; a single action green; solar amber reserved as a sparing accent (the wordmark's "MOT", the sun glow, the pass stamp, primary CTAs on dark). Warm-tinted neutrals rather than cool greys. Plus Jakarta Sans for display, Inter for body, both loaded from Google Fonts with a full system-font fallback stack, so the site still renders correctly if fonts are blocked or slow.

**Motion:** a sticky header that gains a border and shadow on scroll, and staggered scroll-reveal on card grids. Two deliberate robustness choices here:

1. Reveal styles are gated behind a `.js` class set on `<html>` by an inline script, so content is **visible by default** and never stranded at `opacity: 0` if JavaScript fails.
2. Reveals are driven by a rAF-throttled scroll-position check rather than `IntersectionObserver`, because an observer can miss elements during a fast scroll or anchor jump and leave them permanently hidden.

Everything honours `prefers-reduced-motion`. Fully responsive down to 390px with a collapsing nav; verified with headless Chromium at 1440px and 390px for horizontal overflow and stuck-hidden elements.

## Local development

No build step for the front end. To run the backend locally: `npm install`, then `netlify dev` (requires the Netlify CLI) to serve the site with working `/api/*` functions and Blobs on `localhost`.
