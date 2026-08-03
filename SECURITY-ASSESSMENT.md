# SolarMOT — security assessment

**Target:** solarmot.co.uk (Netlify, static site + 8 serverless functions, Netlify Blobs storage)
**Date:** 27 July 2026
**Method:** source review of the live codebase, plus non-destructive probing of the production site.

Every finding below is traced to either a specific line of code in this repository or a
response I got from the live site. Where I could not verify something, I say so rather
than guessing — those are collected in "What I could not test".

---

## Status

Findings **1, 2, 3 and 4 were fixed on 27 July 2026**, immediately after this
assessment. The original text is kept below unchanged, because a record of what was
wrong is more useful than a document that pretends it never was. See
"Remediation" at the end for what changed.

## Summary

| # | Finding | Severity | Verified by |
|---|---------|----------|-------------|
| 1 | Anyone can make the site send email to any address they choose, unlimited | **High** | Source + live |
| 2 | No rate limiting on any public endpoint | **High** | Source |
| 3 | No length limit on any stored field; 5 MB bodies accepted | **Medium–High** | Live probe |
| 4 | No security headers at all (no CSP, no X-Frame-Options, etc.) | **Medium** | Live headers |
| 5 | Admin bearer token held in browser storage, with no CSP behind it | **Medium** | Source |
| 6 | HSTS without `includeSubDomains` or `preload` | **Low–Medium** | Live headers |
| 7 | `NETLIFY_API_TOKEN` would give whole-account access if leaked | **Medium** (latent) | Source |
| 8 | Backups are manual only | **Medium** | Source |
| 9 | Public repository discloses the whole defensive design | **Low** | Observation |

Two things I want to be straight about before the detail:

- **Finding 1 is mine.** I introduced it a few hours ago when I built the customer
  auto-reply. It is the most serious item on this list and it is a direct consequence of
  a feature I added without thinking through the abuse case.
- **Nothing here is currently being exploited** as far as I can tell, and the site holds
  very little data yet. These are pre-launch fixes, not an incident.

---

## Part 1 — Attacker's view

I approached this as someone who has found solarmot.co.uk, can read the public
GitHub repository (`rbrunt1/dorset-solar-care`), and wants to cause damage without
needing any credentials.

### 1.1 Use the site as a free email cannon — **High**

**What I found.** `netlify/functions/_lib/acknowledge.js` sends the customer
acknowledgement to whatever address arrived in the form:

```js
to: [to],           // to = String(record.email)
```

That address is entirely attacker-controlled, there is no verification that the
submitter owns it, and — per finding 2 — nothing limits how often this can be done.

**What an attacker does.** Scripts a loop against `/api/submit-enquiry` with
`email` set to a victim's address. Each request sends that victim a genuine,
DKIM-signed email from `hello@solarmot.co.uk`. A few thousand requests is a
mailbombing campaign attributable to your domain.

**Why it matters more than it looks.**

- The victim reports `solarmot.co.uk` as a spam source. You have spent this week
  building sending reputation from zero with Microsoft; this destroys it.
- Resend's quota is consumed at your cost, and abuse may get the account suspended.
- Each request also writes a Blobs record and sends *you* a notification, so your
  own inbox and storage are collateral.

**Caveats, honestly.** The email body is fixed, so this cannot be used to send
arbitrary spam content — it is a mailbomb and a reputation attack, not an open relay
in the classic sense. The bot traps (`_hp_website`, `_fillMs`) do not help: both are
visible in `js/main.js`, which is public.

**Fix.** Rate-limit acknowledgements per recipient address and per source IP, and cap
per day. The `_lib/ratelimit.js` module already written for the admin page can be reused.

### 1.2 No rate limiting on anything public — **High**

**What I found.** Only one function references the limiter:

```
$ grep -rln "checkRateLimit" netlify/functions/
netlify/functions/_lib/ratelimit.js
netlify/functions/admin-data.js
```

`submit-enquiry`, `submit-quote`, `submit-booking`, `register-interest` and
`gocardless-create-billing-request` have none.

**What an attacker does.** Sustained POSTs to any of them. Consequences compound:
Netlify function invocations (billable), Blobs writes (billable, and unbounded),
Resend sends (quota), and your notification inbox.

**Related weakness this exposes.** `_lib/store.js` reads the whole store to render the
admin page, with `DEFAULT_MAX_RECORDS = 1000`. Past that the dashboard silently
truncates — so an attacker who inserts a few thousand junk records makes your real
leads hard to find, without needing any access.

### 1.3 Unlimited field sizes — **Medium–High**

**What I found.** The `build()` function of each endpoint copies fields straight
through with no length limit — e.g. `netlify/functions/submit-enquiry.js`:

```js
build: (data) => ({ name: data.name, postcode: ..., message: data.message || null })
```

The only cap anywhere is on the attribution object (`MAX_SOURCE_LEN = 500` in
`store.js`), which does not apply to customer fields.

**Live confirmation.** I posted bodies of 100 KB, 1 MB and 5 MB to
`/api/submit-enquiry` in production. All three reached the function and were parsed;
each was rejected only because I deliberately omitted `name`:

```json
[{"kb":100,"status":400,...},{"kb":1024,"status":400,...},{"kb":5120,"status":400,...}]
```

With `name` present, a 5 MB record would have been stored and emailed to you.

**Fix.** Cap each field at a sensible length (name 100, postcode 12, message 5,000)
and reject oversized bodies early.

### 1.4 No security headers — **Medium**

**Live check** of `https://solarmot.co.uk/` and `/admin`:

| Header | Value |
|---|---|
| `content-security-policy` | **absent** |
| `x-frame-options` | **absent** |
| `x-content-type-options` | **absent** |
| `referrer-policy` | **absent** |
| `permissions-policy` | **absent** |
| `strict-transport-security` | `max-age=31536000` |

Consequences:

- **Clickjacking of the admin page.** With no `X-Frame-Options` or CSP
  `frame-ancestors`, `/admin` can be framed on an attacker's page and your clicks
  hijacked — including "Send it" on the area-announcement flow.
- **No defence-in-depth against XSS.** The admin JavaScript does escape output
  (`esc()` in `js/admin.js`), which is the primary control and it is correct. But a
  single missed spot would run unchecked, and could read the admin token straight out
  of `sessionStorage`. A CSP is the second line that is currently missing.
- **MIME sniffing** is possible without `X-Content-Type-Options: nosniff`.
- **Referrer leakage**: without a `Referrer-Policy`, navigating away from
  `/admin?...` can leak the path to third parties.

**Fix.** Netlify sets these from `netlify.toml` with a `[[headers]]` block. Cheap and
low-risk.

### 1.5 Admin session handling — **Medium**

The token is a bearer credential kept in `sessionStorage` (`js/admin.js`,
`TOKEN_KEY = 'solarmot:admin-token'`). Choosing sessionStorage over localStorage was
deliberate and is the better of the two — it dies with the tab. But any script running
on that page can read it, which is why the missing CSP (1.4) matters here specifically.

Positives, verified in `_lib/auth.js`: comparison is constant-time via SHA-256 +
`crypto.timingSafeEqual`, it fails closed when `ADMIN_TOKEN` is unset, and both sides
are trimmed. Rate limiting on failed sign-ins is present and escalating.

**Not a finding, but considered:** CSRF. The admin API authenticates with an
`Authorization` header, not a cookie, so a cross-site request cannot carry credentials.
No CSRF token is needed.

### 1.6 Things I attacked and could *not* break

Worth recording, so this reads as an assessment rather than a list of complaints:

- **Email header injection** — not possible. Resend is called as a JSON API, so
  newlines in a name or address cannot forge headers.
- **HTML injection into emails** — blocked. `escapeHtml()` is applied in both
  `notify.js` and `acknowledge.js`, and there are tests asserting a `<script>` payload
  survives only in escaped form.
- **Forging a GoCardless webhook** — blocked. `gocardless-webhook.js` verifies an
  HMAC-SHA256 over the raw body with constant-time comparison, and returns 503 when
  unconfigured rather than trusting the caller.
- **Faking payment success via the browser redirect** — blocked. Customer status is
  only set from a verified webhook, never from `?gc_status=success`.
- **Timing attack on the admin token** — mitigated (see 1.5).
- **Secrets in the repository** — I grepped for API-key and private-key patterns
  across all tracked files and found none.
- **Cross-origin reads of the API** — no CORS headers are set, so browsers block
  cross-origin reads. (Note this stops *browsers*, not scripts; it is not an access
  control.)

---

## Part 2 — STRIDE

STRIDE is Microsoft's threat-classification model (Spoofing, Tampering, Repudiation,
Information disclosure, Denial of service, Elevation of privilege). Applied to the
three trust boundaries here: public visitor → functions; owner → admin API;
functions → third parties (Resend, GoCardless, Blobs).

### Spoofing
| Threat | State |
|---|---|
| Impersonating the owner to the admin API | **Controlled.** Constant-time token check, fails closed, 5 attempts then escalating block, global cap. |
| Forging a GoCardless webhook | **Controlled.** HMAC-SHA256 over raw body. |
| Sending email as solarmot.co.uk | **Partly controlled.** SPF, DKIM and DMARC (`p=none`) are published. Policy is monitor-only, so spoofed mail is not yet *rejected*. |
| Impersonating a customer at a form | **Not controlled, low impact.** Anyone can submit as anyone; it produces a junk lead, not access. |

### Tampering
| Threat | State |
|---|---|
| Altering stored leads/customers | **Controlled.** Writes require the admin token. |
| Altering price charged | **Controlled.** Prices are server-side constants in `gocardless-webhook.js`; the plan is read back from the mandate rather than trusted from the event. |
| Altering the deployed site | **Depends on your accounts** — see "What I could not test". |

### Repudiation
| Threat | State |
|---|---|
| Disputing that a lead was submitted | **Partly controlled.** Every submission logs `received` / `stored` / `complete` with a request id, but Netlify keeps logs for 24 hours only. |
| Disputing an admin action | **Weak.** No audit trail of who changed a lead status, converted a customer, or sent an area announcement. Single-operator business, so impact is low today. |

### Information disclosure
| Threat | State |
|---|---|
| Customer PII in function logs | **Controlled**, deliberately — logs record which fields were present, never values. Full record is written only on a storage failure, under `LEAD_RECOVERY`. |
| PII exposed via the admin API | **Controlled** by the token. |
| Referrer / framing leakage | **Not controlled** — see 1.4. |
| Source code disclosure | **Accepted.** Public repo; no secrets in it, but the defensive design is visible. |

### Denial of service
| Threat | State |
|---|---|
| Flooding public endpoints | **Not controlled** — 1.2. |
| Exhausting storage | **Not controlled** — 1.2 + 1.3. |
| Locking the owner out of admin | **Considered and handled.** The limiter fails *open* on a Blobs outage precisely so a storage problem cannot lock you out. |
| Burning Netlify credits | **Not controlled.** Exhausting plan credits previously paused production deploys on this project. |

### Elevation of privilege
| Threat | State |
|---|---|
| Public visitor → admin | No path found. |
| Admin token → Netlify account | **Latent.** If `NETLIFY_API_TOKEN` is added for the weekly digest, it is a personal access token with account-wide scope. Anyone reading it holds your whole Netlify account — including the container business in the same team. |

---

## Part 3 — Recommendations, in order

1. **Rate-limit the public endpoints, and cap acknowledgements per address.**
   Closes 1.1 and 1.2. Reuses code that already exists.
2. **Cap field lengths and reject oversized bodies.** Closes 1.3.
3. **Add security headers via `netlify.toml`.** Closes 1.4, helps 1.5.
4. **Automate the backup.** Blobs has no snapshot facility; today a backup happens
   only when you remember to click a button.
5. **Strengthen HSTS** to `max-age=31536000; includeSubDomains; preload`.
   Only after you are sure every subdomain will always be HTTPS.
6. **Reconsider `NETLIFY_API_TOKEN`.** The weekly digest is the only thing needing it.
   Weigh that against handing an account-wide credential to a scheduled function.
7. **Move DMARC to `p=quarantine`** once you have a few weeks of clean delivery.
8. **Separate the two businesses** into different Netlify teams — a compromise or
   billing problem on one currently reaches the other.

---

## What I could not test

I have no visibility into these, and they are plausibly a bigger risk than anything
in the code:

- Whether 2FA is enabled on **GitHub**, **Netlify**, **Namecheap**, **Resend** and
  **Namecheap Private Email**. Namecheap is the highest-value target of those: control
  of DNS means control of the domain, the mail and the TLS certificates.
- The strength of the `ADMIN_TOKEN` you chose, and whether it is reused anywhere else.
- Whether your Mac has FileVault enabled, given customer backups download to it.
- Whether Netlify Blobs encrypts at rest — I did not verify this and would not assert it.
- GoCardless account security, which is not yet set up.

---

## Standing risks that are business decisions, not bugs

- **Netlify Blobs is not a database.** No compare-and-swap, no query layer, no
  automated backup, and the admin view truncates past 1,000 records. Fine for launch;
  it will need replacing before it holds a few thousand customers.
- **The repository is public.** Nothing secret is in it, but every control described
  above is readable by an attacker.


---

## Remediation — 27 July 2026

**Finding 1 (email cannon) and 2 (no rate limiting)** — `_lib/publiclimit.js`:

- Acknowledgements are capped at **3 per recipient address per 24 hours**, keyed
  case-insensitively so `Victim@x` and `victim@x` share one quota. The cap is per
  *recipient*, not per source, so rotating IPs does not get round it.
- Hitting the cap suppresses **only the outbound email**. The lead is still stored
  and you are still notified — a real person filling the form twice must not lose
  their enquiry.
- Submissions are capped at **20 per IP per hour**. Deliberately generous: this
  guards a contact form used by strangers, so a false positive costs a customer.
- Both fail **open** on a storage error, matching the reasoning used elsewhere.

**Finding 3 (unbounded input)** — `_lib/limits.js`:

- Bodies over **64 KB** are refused with 413, checked *before* `JSON.parse` so a
  huge payload is never parsed. The 5 MB probe from section 1.3 is now rejected.
- Every field is capped (name 120, message 5,000, and so on). A long message is
  **truncated and kept**, not rejected, and the truncation is logged so you know a
  customer's message was cut short.
- Byte length is measured, not character count, so multi-byte text cannot slip past.

**Finding 4 (no security headers)** — `netlify.toml`:

- CSP with `frame-ancestors 'none'`, plus `X-Frame-Options: DENY` — this closes the
  clickjacking route to the admin page's action buttons.
- `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`.
- `/admin` additionally gets `X-Robots-Tag: noindex` and `Cache-Control: no-store`.

The CSP keeps `'unsafe-inline'` for scripts because several pages carry inline
`<script>` blocks. Moving those into files would let it be tightened, and is worth
doing, but it is a larger change than this.

**24 new tests**, 201 in the suite. Findings 5–9 remain open and are business
decisions rather than defects.
