# TechCatalyst Review Seal

TechCatalyst acts as a certifying authority for business reviews. A certified business embeds a seal on its website; every page view checks the seal **live** against TechCatalyst, so it reflects the current state: verified, under review, expired, suspended, or revoked. Each response carries an **ES256-signed attestation** with a short lifetime, and the certificate itself has an expiry date — the same model as the old "secured by" TLS seals, applied to reviews.

Runs on **Cloudflare Workers + D1**. No servers to patch.

```
Customer browser ──► client site ──► embed.js ──► GET /v1/seals/:id ──► D1 (cached 30s at edge)
                                         │                 └── signed JWS attestation (10 min)
                                         └── click ──► /verify/<business>  (the trust anchor)
```

## What the seal attests

> "Of this business's **last N reviews**, at least **X%** are verified by TechCatalyst, and the certificate is valid until **date**."

N, X and the minimum review count are set per certificate (defaults: last 10, 100%, at least 5). This is re-evaluated continuously: if new unverified reviews push the ratio below the bar, the seal turns amber (**Under Review**) on its own, even before expiry.

A review counts as verified when it is:

| Mark | How it gets there |
|---|---|
| **Verified purchase** (`transaction`) | Business reports a real order → TechCatalyst sends a single-use review link → customer submits. Auto-approved when the fraud score is low; otherwise queued for an analyst. |
| **Audited** (`audited`) | Business imports a review from Google, Yelp, Facebook or CSV → an analyst checks it against the source listing and approves. |

Every review is fraud-scored first: same IP within 30 days, burst volume, near-duplicate text (3-word shingle Jaccard), disposable email domains, embedded links, very short or low-effort 5-star text, and submissions seconds after the invite. Score ≥ 50 is **held** and never auto-approved. Fraud signals are never shown to the business, so they can't be used to tune fake reviews.

## Quick start (local)

```bash
npm install
npm run gen:dev-vars             # writes .dev.vars with a signing key, hash secret, bootstrap token
npm run db:migrate:local
npm run dev                      # http://127.0.0.1:8787
```

Mint the first admin key (works exactly once):

```bash
curl -X POST http://127.0.0.1:8787/v1/bootstrap -H "x-bootstrap-token: <BOOTSTRAP_TOKEN from .dev.vars>"
```

Then sign in at `/admin/` with that key. Business owners use `/portal/`.

Run the end-to-end suite (71 checks, ~3 min because it waits out the edge cache) against a **fresh** local DB:

```bash
npm test
```

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler d1 create techcatalyst-seal          # paste database_id into wrangler.toml
npm run db:migrate:remote
npm run gen:secrets                                # prints values; never written to disk
npx wrangler secret put SIGNING_KEY_JWK
npx wrangler secret put HASH_SECRET
npx wrangler secret put BOOTSTRAP_TOKEN
# set PUBLIC_ORIGIN in wrangler.toml to your real origin, e.g. https://seal.techcatalyst.com
npm run deploy
curl -X POST https://seal.techcatalyst.com/v1/bootstrap -H "x-bootstrap-token: …"
npx wrangler secret delete BOOTSTRAP_TOKEN         # bootstrap is now disabled for good
```

Put the Worker on a dedicated hostname (e.g. `seal.techcatalyst.com`) via a Custom Domain, then add a **WAF rate-limiting rule** for `/v1/seals/*` and `/review/*` (the in-app limiter is defense in depth, not the first line).

To email invitations directly, set `MAIL_PROVIDER = "resend"`, `MAIL_FROM`, and `wrangler secret put RESEND_API_KEY`. Without it, the API returns each one-time link for the business to deliver.

## Operating flow

1. **Register** the business in `/admin/` after verifying it owns its domain (DNS TXT or email to the domain contact). The registered website is the only domain the business can bind seals to on its own.
2. **Issue a business API key** and send it over a secure channel.
3. The business **invites customers** after real orders (portal or API) and/or **imports existing reviews**.
4. Analysts work the **review queue** (highest risk first).
5. When eligible, **issue a certificate** (max 397 days). Issuance is refused if the bar isn't met unless you force it with a note.
6. The business **creates a seal** and pastes the snippet. Renew before expiry; suspend or revoke if a complaint is confirmed — the change reaches every embedded seal within 30 seconds.

## Embedding

```html
<!-- Recommended: live, auto-refreshing, rendered in a closed Shadow DOM -->
<script src="https://seal.techcatalyst.com/embed.js" data-tc-seal="seal_xxxxxxxxxxxxxxxx" async></script>

<!-- No-JS fallback -->
<a href="https://seal.techcatalyst.com/s/seal_xxxxxxxxxxxxxxxx" target="_blank" rel="noopener">
  <img src="https://seal.techcatalyst.com/v1/seals/seal_xxxxxxxxxxxxxxxx/badge.svg" width="300" height="64" alt="TechCatalyst review verification seal">
</a>
```

## API

Authenticate with `Authorization: Bearer tck_key_…`. Keys are shown once, stored only as SHA-256, can carry an expiry, and are revocable instantly. Portals exchange the key for an `__Host-` HttpOnly, Secure, SameSite=Strict session cookie.

**Public**

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/seals/:id` | Live status + signed attestation (CORS `*`, no credentials) |
| GET | `/v1/seals/:id/badge.svg` | Server-rendered seal |
| GET | `/s/:id` | Seal click-through → verify page |
| GET | `/verify/:slug` | Public verification page |
| GET | `/.well-known/jwks.json` | Public key to verify attestations offline |
| GET/POST | `/review/:token` | Customer review form (single-use invite link) |
| POST | `/v1/bootstrap` | One-time first admin key |
| POST/GET/DELETE | `/v1/auth/session`, `/v1/auth/me` | Portal sessions |

**Business key** (`/v1/business/…`): `GET me` · `POST/GET invitations` · `POST reviews/import` · `GET reviews` · `GET/POST seals`, `DELETE seals/:id` · `GET/POST keys`, `DELETE keys/:id`

**Admin key** (`/v1/admin/…`): `GET/POST businesses` · `GET/PATCH businesses/:id` · `GET businesses/:id/eligibility` · `POST businesses/:id/certifications` · `POST certifications/:id/status` · `POST businesses/:id/seals`, `DELETE seals/:id` · `GET reviews?status=queue|pending|held|approved|rejected` · `POST reviews/:id/decision` · `GET/POST keys`, `DELETE keys/:id` · `GET audit`

Example — invite after checkout:

```bash
curl -X POST https://seal.techcatalyst.com/v1/business/invitations \
  -H "Authorization: Bearer $TC_KEY" -H "content-type: application/json" \
  -d '{"orders":[{"order_ref":"A-1001","email":"maria@example.com","customer_name":"Maria G."}]}'
```

Attestation payload (JWS, ES256, `kid` matches JWKS):

```json
{ "iss": "https://seal.techcatalyst.com", "sub": "seal_…", "iat": 1760220000, "exp": 1760220600,
  "business": { "slug": "acme-plumbing", "name": "Acme Plumbing" }, "domains": ["acmeplumbing.com"],
  "requested_by": "www.acmeplumbing.com", "state": "verified",
  "certification": { "id": "cert_…", "status": "active", "issued_at": 1760000000, "expires_at": 1791536000 },
  "recent_reviews": { "window": 10, "considered": 10, "verified": 10 },
  "verify_url": "https://seal.techcatalyst.com/s/seal_…" }
```

See [SECURITY.md](SECURITY.md) for the threat model.

## Project layout

```
src/index.ts            app, error handling, hourly housekeeping cron
src/security.ts         auth, sessions, CSRF origin checks, rate limits, headers, audit
src/crypto.ts           key generation/hashing, HMAC, ES256 JWS signing (WebCrypto only)
src/status.ts           live certification state + "last N reviews" eligibility
src/fraud.ts            fraud scoring
src/routes/admin.ts     certification authority operations
src/routes/business.ts  business self-service API
src/routes/public.ts    seals, verify page, review form, JWKS, sessions, bootstrap
public/                 embed.js, admin + business portals, styles, _headers (CSP)
migrations/             D1 schema
scripts/e2e.mjs         end-to-end + security test suite
```
