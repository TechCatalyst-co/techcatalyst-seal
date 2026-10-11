// End-to-end test against a running dev server (npm run dev) with a fresh local D1.
//   BASE=http://127.0.0.1:8787 BOOTSTRAP_TOKEN=... node scripts/e2e.mjs
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const BOOT = process.env.BOOTSTRAP_TOKEN ?? /BOOTSTRAP_TOKEN='([^']+)'/.exec(readFileSync('.dev.vars', 'utf8'))?.[1];
let passed = 0;
const fails = [];
const ok = (cond, name, extra) => {
  if (cond) passed++;
  else fails.push(name + (extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 300)}` : ''));
  console.log(`${cond ? '✔' : '✘'} ${name}`);
};
const runId = Date.now().toString(36);
// Each run looks like a different client IP so rate limits/fraud IP checks are deterministic.
let ipCounter = 1;
const freshIp = () => `10.${(Date.now() >> 8) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

async function call(method, path, { key, body, headers = {}, ip } = {}) {
  const h = { 'cf-connecting-ip': ip ?? '10.0.0.1', ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function verifyJws(jws, jwks) {
  const [h, p, s] = jws.split('.');
  const header = JSON.parse(b64urlDecode(h));
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'ES256') return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  return valid ? JSON.parse(b64urlDecode(p)) : null;
}

// ---------- Bootstrap ----------
let r = await call('POST', '/v1/bootstrap', { headers: { 'x-bootstrap-token': 'wrong'.padEnd(43, 'x') }, ip: freshIp() });
ok(r.status === 401, 'bootstrap rejects wrong token');
r = await call('POST', '/v1/bootstrap', { headers: { 'x-bootstrap-token': BOOT }, ip: freshIp() });
let ADMIN;
if (r.status === 201) ADMIN = r.json.token;
else if (r.status === 409 && process.env.ADMIN_KEY) ADMIN = process.env.ADMIN_KEY;
ok(!!ADMIN && /^tck_key_[a-z2-9]{12}\.[A-Za-z0-9_-]{43}$/.test(ADMIN), 'bootstrap mints admin key (format)', r.json);
r = await call('POST', '/v1/bootstrap', { headers: { 'x-bootstrap-token': BOOT }, ip: freshIp() });
ok(r.status === 409, 'bootstrap is one-time only');

// ---------- AuthN / AuthZ ----------
r = await call('GET', '/v1/admin/businesses', { ip: freshIp() });
ok(r.status === 401, 'admin API requires auth');
r = await call('GET', '/v1/admin/businesses', { key: ADMIN.slice(0, -2) + 'AA', ip: freshIp() });
ok(r.status === 401, 'tampered key rejected');
r = await call('GET', '/v1/admin/businesses', { key: ADMIN });
ok(r.status === 200, 'admin key works');
ok(!r.headers.get('access-control-allow-origin'), 'private API sends no CORS headers');

// ---------- Business setup ----------
const slug = `acme-${runId}`;
r = await call('POST', '/v1/admin/businesses', { key: ADMIN, body: { name: 'Acme Plumbing <script>', slug, website: 'https://www.acme-test.com/', contact_email: 'owner@acme-test.com' } });
ok(r.status === 201 && r.json.website === 'www.acme-test.com', 'create business (normalizes website)', r.json);
const BIZ = r.json.id;
r = await call('POST', '/v1/admin/businesses', { key: ADMIN, body: { name: 'Dup', slug, website: 'x.com' } });
ok(r.status === 409, 'duplicate slug rejected');
r = await call('POST', '/v1/admin/businesses', { key: ADMIN, body: { name: 'Bad', slug: 'Bad Slug!', website: 'x.com' } });
ok(r.status === 400, 'invalid slug rejected');

r = await call('POST', '/v1/admin/keys', { key: ADMIN, body: { role: 'business', business_id: BIZ, label: 'owner' } });
ok(r.status === 201, 'issue business key');
const BKEY = r.json.token;
r = await call('GET', '/v1/admin/businesses', { key: BKEY });
ok(r.status === 403, 'business key cannot reach admin API');

// Second business to test tenant isolation
r = await call('POST', '/v1/admin/businesses', { key: ADMIN, body: { name: 'Other Co', slug: `other-${runId}`, website: 'other-test.com' } });
const BIZ2 = r.json.id;
r = await call('POST', '/v1/admin/keys', { key: ADMIN, body: { role: 'business', business_id: BIZ2, label: 'other' } });
const BKEY2 = r.json.token;

// ---------- Seals ----------
r = await call('POST', '/v1/business/seals', { key: BKEY, body: { domains: ['evil-test.com'] } });
ok(r.status === 403, 'business cannot bind seal to unregistered domain');
r = await call('POST', '/v1/business/seals', { key: BKEY, body: { domains: ['www.acme-test.com', 'shop.www.acme-test.com'] } });
ok(r.status === 201 && /^seal_[a-z2-9]{16}$/.test(r.json.id), 'create seal', r.json);
const SEAL = r.json.id;
r = await call('DELETE', `/v1/business/seals/${SEAL}`, { key: BKEY2 });
ok(r.status === 404, "tenant isolation: other business can't revoke my seal");

const jwks = (await call('GET', '/.well-known/jwks.json')).json;
ok(jwks?.keys?.[0]?.kty === 'EC' && !('d' in jwks.keys[0]), 'JWKS exposes public key only');

r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com' } });
ok(r.status === 200 && r.json.state === 'not_certified' && r.json.valid === false, 'seal: not certified yet', r.json);

// ---------- Invitations → transaction-verified reviews ----------
const orders = Array.from({ length: 6 }, (_, i) => ({ order_ref: `A-${i}`, email: `cust${i}@example.com`, customer_name: `Customer ${i}` }));
r = await call('POST', '/v1/business/invitations', { key: BKEY, body: { orders } });
ok(r.status === 201 && r.json.invitations.every((i) => i.link), 'create invitations', r.json);
const links = r.json.invitations.map((i) => i.link);
r = await call('POST', '/v1/business/invitations', { key: BKEY, body: { orders: [orders[0]] } });
ok(r.json.invitations[0].status === 'duplicate_order', 'duplicate order ref rejected');

const texts = [
  'Arrived on time, fixed the leaking pipe under the sink and cleaned up after. Fair price.',
  'Water heater replaced in a single afternoon. Technician explained every step clearly.',
  'Good communication by text before the visit. Slightly pricier than expected but solid work.',
  'They found a hidden crack in the drain line that two other companies missed. Grateful.',
  'Scheduling was easy online, the plumber was courteous and wore shoe covers inside.',
];
await new Promise((res) => setTimeout(res, 61000)); // avoid the "submitted <60s after invite" flag for the clean path
for (let i = 0; i < 5; i++) {
  const path = new URL(links[i]).pathname;
  const g = await call('GET', path, { ip: freshIp() });
  if (i === 0) ok(g.status === 200 && g.text.includes('Acme Plumbing &lt;script&gt;'), 'review form renders with escaped business name');
  if (i === 0) ok((g.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'review form has strict CSP');
  if (i === 0) ok(g.headers.get('referrer-policy') === 'no-referrer', 'review form never leaks token via Referer');
  const form = new URLSearchParams({ rating: String(5 - (i % 2)), title: `Review ${i}`, body: texts[i], author_name: `C${i}` });
  const p = await fetch(BASE + path, { method: 'POST', body: form, headers: { origin: BASE, 'cf-connecting-ip': freshIp(), 'user-agent': `UA-${i}` } });
  const html = await p.text();
  if (i === 0) ok(p.status === 200 && html.includes('published'), 'clean invite review auto-approved', html.slice(0, 200));
}
// Replay / CSRF
const firstPath = new URL(links[0]).pathname;
r = await fetch(BASE + firstPath, { method: 'POST', body: new URLSearchParams({ rating: '1', body: 'replay attempt with enough text' }), headers: { origin: BASE } });
ok(r.status === 410, 'invite link is single-use');
r = await fetch(BASE + new URL(links[5]).pathname, { method: 'POST', body: new URLSearchParams({ rating: '5', body: 'cross site forged submission' }), headers: { origin: 'https://evil.example' } });
ok(r.status === 403, 'cross-origin review POST rejected');
r = await call('GET', '/review/not-a-real-token');
ok(r.status === 404, 'garbage token 404');

// ---------- Eligibility & certification ----------
r = await call('GET', `/v1/admin/businesses/${BIZ}/eligibility?window=10&min_reviews=5&min_ratio=1`, { key: ADMIN });
ok(r.json.verified === 5 && r.json.meets === true, 'eligibility: 5/5 verified', r.json);
r = await call('POST', `/v1/admin/businesses/${BIZ}/certifications`, { key: BKEY, body: { valid_days: 365 } });
ok(r.status === 403, 'business cannot self-certify');
r = await call('POST', `/v1/admin/businesses/${BIZ}/certifications`, { key: ADMIN, body: { valid_days: 365, review_window: 10, min_verified_ratio: 1, min_reviews: 5 } });
ok(r.status === 201, 'issue certificate', r.json);
const CERT = r.json.id;
r = await call('POST', `/v1/admin/businesses/${BIZ2}/certifications`, { key: ADMIN, body: { valid_days: 365 } });
ok(r.status === 409 && r.json.error === 'not_eligible', 'ineligible business cannot be certified without force');

// ---------- Live seal ----------
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com' } });
ok(r.json.state === 'verified' && r.json.valid === true, 'seal verified on its own domain', r.json);
ok(r.headers.get('access-control-allow-origin') === '*', 'seal endpoint is CORS-public');
const claims = await verifyJws(r.json.attestation, jwks);
ok(!!claims && claims.sub === SEAL && claims.state === 'verified' && claims.exp > claims.iat, 'attestation signature verifies against JWKS', claims);
const tampered = r.json.attestation.split('.');
tampered[1] = Buffer.from(JSON.stringify({ ...claims, state: 'verified', business: { name: 'Evil' } })).toString('base64url');
ok((await verifyJws(tampered.join('.'), jwks)) === null, 'tampered attestation fails verification');

r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://shop.www.acme-test.com' } });
ok(r.json.state === 'verified', 'seal valid on allowed subdomain');
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://copycat-test.com' } });
ok(r.json.state === 'domain_mismatch' && r.json.valid === false, 'copied seal shows domain mismatch');
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com.evil.com' } });
ok(r.json.state === 'domain_mismatch', 'suffix-trick domain rejected');
r = await call('GET', `/v1/seals/${SEAL}/badge.svg`, { headers: { referer: 'https://copycat-test.com/page' } });
ok(r.text.includes('Not Valid On This Site'), 'SVG badge shows mismatch for wrong referer');
r = await call('GET', `/v1/seals/${SEAL}/badge.svg`, { headers: { referer: 'https://www.acme-test.com/' } });
ok(r.text.includes('Reviews Verified') && r.headers.get('content-type').startsWith('image/svg+xml'), 'SVG badge verified on own site');
ok(!r.text.includes('<script'), 'SVG badge contains no script');
r = await call('GET', `/v1/seals/seal_aaaaaaaaaaaaaaaa`);
ok(r.status === 404, 'unknown seal 404');

r = await call('GET', `/s/${SEAL}`);
ok(r.status === 302 && r.headers.get('location').includes(`/verify/${slug}?seal=${SEAL}`), 'seal click-through redirects to verify page');
r = await call('GET', `/verify/${slug}?seal=${SEAL}`);
ok(r.status === 200 && r.text.includes('Reviews Verified') && r.text.includes('www.acme-test.com') && !r.text.includes('<script>'), 'verify page shows status, domains, escapes HTML');

// ---------- Fraud: near-duplicate + same IP gets held, seal drops to amber ----------
r = await call('POST', '/v1/business/invitations', { key: BKEY, body: { orders: [{ order_ref: 'B-1', email: 'x@mailinator.com' }, { order_ref: 'B-2', email: 'y@example.com' }] } });
const [l1, l2] = r.json.invitations.map((i) => new URL(i.link).pathname);
const shared = '10.200.200.200';
await fetch(BASE + l1, { method: 'POST', body: new URLSearchParams({ rating: '5', body: texts[0] }), headers: { origin: BASE, 'cf-connecting-ip': shared } });
await fetch(BASE + l2, { method: 'POST', body: new URLSearchParams({ rating: '5', body: texts[0] + ' Great.' }), headers: { origin: BASE, 'cf-connecting-ip': shared } });
r = await call('GET', `/v1/admin/reviews?status=queue&business_id=${BIZ}`, { key: ADMIN });
const held = r.json.reviews.filter((x) => x.status === 'held');
ok(held.length === 2 && held.every((x) => x.fraud_flags.some((f) => f.startsWith('near_duplicate'))), 'copy-paste reviews held with flags', r.json.reviews.map((x) => [x.status, x.fraud_score, x.fraud_flags]));
ok(held.some((x) => x.fraud_flags.includes('disposable_email')) && held.some((x) => x.fraud_flags.some((f) => f.startsWith('same_ip'))), 'disposable email + same IP flagged');
r = await call('GET', `/v1/business/reviews`, { key: BKEY });
ok(r.json.reviews.every((x) => !('fraud_flags' in x) && !('fraud_score' in x)), 'fraud signals hidden from businesses');

await new Promise((res) => setTimeout(res, 31000)); // edge status cache TTL
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com' } });
ok(r.json.state === 'under_review', 'seal turns amber when recent reviews are unverified', r.json);

for (const x of held) await call('POST', `/v1/admin/reviews/${x.id}/decision`, { key: ADMIN, body: { decision: 'reject', note: 'duplicate' } });

// ---------- Imports → audit ----------
const now = Math.floor(Date.now() / 1000);
r = await call('POST', '/v1/business/reviews/import', { key: BKEY, body: { reviews: [
  { source: 'google', external_id: 'g-1', rating: 4, body: 'Imported review about a bathroom remodel that went smoothly overall.', reviewed_at: now - 86400 },
  { source: 'google', external_id: 'g-1', rating: 4, body: 'dup', reviewed_at: now - 86400 },
] } });
ok(r.status === 201 && r.json.inserted === 1 && r.json.duplicates === 1, 'import dedupes by external id', r.json);
r = await call('GET', `/v1/admin/reviews?status=queue&business_id=${BIZ}`, { key: ADMIN });
const imp = r.json.reviews.find((x) => x.external_id === 'g-1');
ok(imp && imp.status === 'pending', 'imported review waits for analyst');
r = await call('POST', `/v1/admin/reviews/${imp.id}/decision`, { key: ADMIN, body: { decision: 'approve', note: 'matched on Google listing' } });
ok(r.json.verification === 'audited', 'approved import becomes "audited"');

await new Promise((res) => setTimeout(res, 31000));
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com' } });
ok(r.json.state === 'verified', 'seal back to verified after audit', r.json);

// ---------- Suspension / revocation ----------
r = await call('POST', `/v1/admin/certifications/${CERT}/status`, { key: ADMIN, body: { status: 'suspended', reason: 'complaint under investigation' } });
ok(r.status === 200, 'suspend certificate');
await new Promise((res) => setTimeout(res, 31000));
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com' } });
ok(r.json.state === 'suspended', 'seal reflects suspension live');
r = await call('POST', `/v1/admin/certifications/${CERT}/status`, { key: ADMIN, body: { status: 'revoked', reason: 'confirmed fake reviews' } });
r = await call('POST', `/v1/admin/certifications/${CERT}/status`, { key: ADMIN, body: { status: 'active', reason: 'try to undo' } });
ok(r.status === 409, 'revocation is final');
await new Promise((res) => setTimeout(res, 31000));
r = await call('GET', `/v1/seals/${SEAL}`, { headers: { origin: 'https://www.acme-test.com' } });
ok(r.json.state === 'revoked', 'seal reflects revocation within cache TTL', r.json.state);

// ---------- Key lifecycle ----------
r = await call('POST', '/v1/business/keys', { key: BKEY, body: { label: 'checkout' } });
const K2 = r.json.token;
const K2id = r.json.id;
ok((await call('GET', '/v1/business/me', { key: K2 })).status === 200, 'business self-service key works');
r = await call('DELETE', `/v1/business/keys/${K2id}`, { key: BKEY2 });
ok(r.status === 404, "tenant isolation: can't revoke another business's key");
r = await call('DELETE', `/v1/business/keys/${K2id}`, { key: BKEY });
ok(r.status === 200, 'revoke key');
ok((await call('GET', '/v1/business/me', { key: K2, ip: freshIp() })).status === 401, 'revoked key stops working immediately');
r = await call('PATCH', `/v1/admin/businesses/${BIZ2}`, { key: ADMIN, body: { status: 'suspended', reason: 'test' } });
ok((await call('GET', '/v1/business/me', { key: BKEY2, ip: freshIp() })).status === 401, 'keys of suspended business stop working');

// ---------- Session cookie + CSRF ----------
const ipS = freshIp();
r = await call('POST', '/v1/auth/session', { body: { api_key: ADMIN }, headers: { origin: 'https://evil.example' }, ip: ipS });
ok(r.status === 403, 'login from foreign origin rejected');
r = await call('POST', '/v1/auth/session', { body: { api_key: ADMIN }, headers: { origin: BASE }, ip: ipS });
const setCookie = r.headers.get('set-cookie') || '';
ok(r.status === 200 && /__Host-tc_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'session cookie is __Host-, HttpOnly, Secure, SameSite=Strict', setCookie);
const cookie = setCookie.split(';')[0];
r = await call('GET', '/v1/admin/keys', { headers: { cookie } });
ok(r.status === 200 && r.json.keys.every((k) => !('secret_hash' in k)), 'session works; secret hashes never returned');
r = await call('POST', '/v1/admin/keys', { headers: { cookie, origin: 'https://evil.example' }, body: { role: 'admin', label: 'csrf' } });
ok(r.status === 403, 'cookie-auth write from foreign origin blocked (CSRF)');
r = await call('POST', '/v1/admin/keys', { headers: { cookie }, body: { role: 'admin', label: 'csrf' } });
ok(r.status === 403, 'cookie-auth write without Origin blocked');

// ---------- Brute force ----------
const ipB = freshIp();
let last;
for (let i = 0; i < 12; i++) last = await call('POST', '/v1/auth/session', { body: { api_key: `tck_key_aaaaaaaaaaaa.${'A'.repeat(43)}` }, headers: { origin: BASE }, ip: ipB });
ok(last.status === 429, 'login brute force is rate limited');

// ---------- Headers & input hardening ----------
r = await call('GET', '/v1/admin/businesses', { key: ADMIN });
ok(r.headers.get('strict-transport-security') && r.headers.get('x-content-type-options') === 'nosniff', 'security headers on API');
r = await fetch(BASE + '/v1/admin/businesses', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{bad json' });
ok(r.status === 400, 'malformed JSON → 400');
r = await fetch(BASE + '/v1/admin/businesses', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(300 * 1024) }) });
ok(r.status === 413, 'oversized body → 413');
r = await call('GET', `/verify/${slug}'%20OR%201=1--`);
ok(r.status === 404, 'SQLi-shaped slug handled safely');

r = await call('GET', '/v1/admin/audit', { key: ADMIN });
ok(r.json.entries.some((e) => e.action === 'certification.revoked') && r.json.entries.some((e) => e.action === 'review.reject'), 'audit log records decisions');

console.log(`\n${passed} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join('\n'));
  process.exit(1);
}
