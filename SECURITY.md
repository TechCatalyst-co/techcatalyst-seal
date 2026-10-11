# Security model

## What a seal can and cannot prove

Any image or script on a page can be faked or screenshotted — that was true of TLS seals too. The design therefore treats the seal as a **pointer**, and the **verify page on TechCatalyst's own domain as the trust anchor**:

- The seal always links to `/s/:id` → `/verify/<business>?seal=…`, which states the domains the seal is valid on and tells the visitor to compare with the address bar.
- Seals are **domain-bound**. `embed.js` fetches status with the browser-set `Origin` header (page scripts cannot forge it); a copied seal renders **Not Valid On This Site**. The SVG fallback applies the same check using `Referer` when present.
- Status is **live** (≤30 s edge cache) and every response carries a **signed, 10-minute attestation** that partners can verify offline via `/.well-known/jwks.json`.

## Threats and controls

| Threat | Control |
|---|---|
| Stolen / leaked API key | 256-bit secrets, stored as SHA-256 only, shown once; optional expiry; instant revocation also kills sessions; per-integration keys; `last_used_at` tracking; audit log |
| Brute-forcing keys / login | Key format validated before DB lookup; constant-time compare; failed auth counted per IP (20 / 5 min); login limited (10 / 5 min); add a WAF rule in production |
| CSRF on portals | `__Host-` cookie, `SameSite=Strict`, plus mandatory `Origin` match on every cookie-authenticated write |
| XSS | All server HTML escaped; portals build DOM with `textContent` only; strict CSP with no inline script; seal rendered in closed Shadow DOM using `textContent`; SVG contains no script |
| Clickjacking | `frame-ancestors 'none'` / `X-Frame-Options: DENY` on all pages |
| Cross-tenant access | Every business query is scoped by the key's `business_id`; tested in e2e |
| Business self-certifies or binds a seal to another site | Only admin keys issue certificates; businesses can bind seals only to their verified website (and subdomains); extra domains require an admin plus an ownership note |
| Fake invite reviews | Single-use 256-bit link tokens (stored hashed), atomic claim, expiry; `no-referrer` so tokens never leak; Origin-checked form POST; fraud scoring → hold |
| Fake imported reviews | Never auto-approved; analyst must approve; dedupe on (source, external id) |
| Learning the fraud model | Scores and flags are never returned to businesses |
| Forged attestation | ES256 signatures; private key only in Worker secrets; JWKS publishes the public half only |
| PII exposure | IPs and user agents stored only as HMAC; customer emails kept in plaintext only until the invite is used or expires (hourly purge), then only an HMAC remains |
| SQL injection | Parameterized statements everywhere; input validated with zod and allow-list regexes |
| Abuse / DoS | Body size limit (256 KB); edge-cached seal status; per-IP limits on public forms; add Cloudflare WAF + Bot Management |
| Insider misuse | Per-person admin keys with expiry; every certification, decision, key and seal action is audit-logged with actor |

## Before going live (recommended next steps)

1. **Domain ownership automation** — DNS TXT challenge (`_techcatalyst.<domain>`) instead of manual verification.
2. **Turnstile** on the review form to stop scripted submissions.
3. **Signing key rotation** — publish old + new keys in JWKS, then switch `SIGNING_KEY_JWK`.
4. **Admin MFA** — put `/admin/*` and `/v1/admin/*` behind Cloudflare Access (SSO + MFA) in addition to API keys.
5. **WAF rate-limiting rules** on `/v1/seals/*`, `/review/*`, `/v1/auth/*`.
6. **Platform APIs for imports** (Google Business Profile API, Yelp Fusion) rather than scraping, and respect each platform's terms.
7. **Legal review** of the attestation wording, your verification criteria and liability terms. In the US, the FTC's rule on fake reviews and testimonials (effective October 2024) is directly relevant to both you and your clients.
8. **External penetration test** before onboarding paying customers — as a certifying authority, your own security posture is the product.
