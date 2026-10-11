import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { now } from '../env';
import { getSigningKey, hmacHex, id, newApiKey, randomToken, sha256Hex, signJws, timingSafeEqual } from '../crypto';
import { HttpError, SESSION_COOKIE, SESSION_TTL, assertSameOrigin, audit, hostAllowed, limit, principalFromKey, resolvePrincipal } from '../security';
import { BusinessStatus, STATE_LABEL, businessStatus } from '../status';
import { badgeSvg } from '../badge';
import { PAGE_CSP, esc, fmtDate, page, stars } from '../html';
import { AUTO_APPROVE_MAX, HOLD_THRESHOLD, scoreReview } from '../fraud';
import { parse } from '../validate';

const pub = new Hono<AppEnv>();

// =====================================================================
// Sessions for the portals (exchange an API key for an HttpOnly cookie)
// =====================================================================
pub.post('/v1/auth/session', limit('login', 10, 300), async (c) => {
  assertSameOrigin(c);
  const body = parse(z.object({ api_key: z.string().max(200) }), await c.req.json());
  const p = await principalFromKey(c.env, body.api_key);
  if (!p) {
    await audit(c.env, 'public', 'auth.login_failed', null, null, c.get('ipHash'));
    throw new HttpError(401, 'invalid_key', 'That key is not valid.');
  }
  const sid = randomToken(32);
  const t = now();
  await c.env.DB.prepare(`INSERT INTO sessions (id_hash, key_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(await sha256Hex(sid), p.keyId, t, t + SESSION_TTL)
    .run();
  setCookie(c, SESSION_COOKIE, sid, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL });
  await audit(c.env, p.keyId, 'auth.login', null, null, c.get('ipHash'));
  return c.json({ role: p.role, business_id: p.businessId });
});

pub.get('/v1/auth/me', async (c) => {
  const p = await resolvePrincipal(c);
  if (!p) throw new HttpError(401, 'unauthorized');
  return c.json({ role: p.role, business_id: p.businessId, key_id: p.keyId });
});

pub.delete('/v1/auth/session', async (c) => {
  assertSameOrigin(c);
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await c.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?1`).bind(await sha256Hex(sid)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
  return c.json({ ok: true });
});

// =====================================================================
// One-time bootstrap: mint the first admin key. Disabled once any admin exists.
// =====================================================================
pub.post('/v1/bootstrap', limit('bootstrap', 5, 3600), async (c) => {
  const supplied = c.req.header('x-bootstrap-token') ?? '';
  const expected = c.env.BOOTSTRAP_TOKEN ?? '';
  if (expected.length < 32 || !timingSafeEqual(await sha256Hex(supplied), await sha256Hex(expected))) {
    throw new HttpError(401, 'unauthorized');
  }
  const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE role = 'admin'`).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) throw new HttpError(409, 'already_bootstrapped', 'An admin key already exists. Remove BOOTSTRAP_TOKEN.');
  const k = await newApiKey();
  await c.env.DB.prepare(`INSERT INTO api_keys (id, secret_hash, role, label, created_by, created_at) VALUES (?1, ?2, 'admin', 'bootstrap admin', 'bootstrap', ?3)`)
    .bind(k.keyId, k.secretHash, now())
    .run();
  await audit(c.env, 'bootstrap', 'key.create', k.keyId, { role: 'admin' }, c.get('ipHash'));
  return c.json({ id: k.keyId, token: k.token, note: 'Store this admin key in your password manager, then delete the BOOTSTRAP_TOKEN secret.' }, 201);
});

// =====================================================================
// Public keys so anyone can verify our signed attestations offline
// =====================================================================
pub.get('/.well-known/jwks.json', async (c) => {
  const { publicJwk } = await getSigningKey(c.env.SIGNING_KEY_JWK);
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('Access-Control-Allow-Origin', '*');
  return c.json({ keys: [publicJwk] });
});

// =====================================================================
// Seal status: called live by embed.js on every page view
// =====================================================================
interface SealRecord {
  seal: { id: string; business_id: string; allowed_domains: string[]; revoked: boolean } | null;
  status: BusinessStatus | null;
  cachedAt?: number;
}

const SEAL_CACHE_SECONDS = 30;

/**
 * Status is cached for 30s per seal at the edge to keep D1 load flat under heavy traffic.
 * The timestamp check enforces the TTL ourselves, so a revocation is never served stale for longer,
 * whatever the cache implementation does with max-age.
 */
async function loadSeal(c: Context<AppEnv>, sealId: string): Promise<SealRecord> {
  if (!/^seal_[a-z2-9]{16}$/.test(sealId)) return { seal: null, status: null };
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(`https://seal-cache.internal/v1/${sealId}`);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) {
    const rec = (await hit.json()) as SealRecord;
    if (rec.cachedAt && now() - rec.cachedAt < SEAL_CACHE_SECONDS) return rec;
  }

  const row = await c.env.DB.prepare(`SELECT id, business_id, allowed_domains, revoked_at FROM seal_tokens WHERE id = ?1`)
    .bind(sealId)
    .first<{ id: string; business_id: string; allowed_domains: string; revoked_at: number | null }>();
  const rec: SealRecord = row
    ? {
        seal: { id: row.id, business_id: row.business_id, allowed_domains: JSON.parse(row.allowed_domains), revoked: !!row.revoked_at },
        status: await businessStatus(c.env, { id: row.business_id }),
      }
    : { seal: null, status: null };
  rec.cachedAt = now();
  if (cache) {
    c.executionCtx.waitUntil(
      cache.put(key, new Response(JSON.stringify(rec), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${SEAL_CACHE_SECONDS}` } }))
    );
  }
  return rec;
}

function requestHost(c: Context<AppEnv>, header: 'origin' | 'referer'): string | null {
  const v = c.req.header(header);
  if (!v || v === 'null') return null;
  try {
    return new URL(v).hostname;
  } catch {
    return null;
  }
}

pub.options('/v1/seals/:id', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET');
  c.header('Access-Control-Max-Age', '86400');
  return c.body(null, 204);
});

pub.get('/v1/seals/:id', async (c) => {
  c.header('Access-Control-Allow-Origin', '*'); // public data, no credentials
  c.header('Cache-Control', 'no-store');
  const sealId = c.req.param('id');
  const { seal, status } = await loadSeal(c, sealId);
  if (!seal || seal.revoked || !status) {
    return c.json({ valid: false, state: 'unknown', message: 'Seal not found or revoked.' }, 404);
  }
  // Browsers set Origin on cross-origin fetch and page JS cannot forge it.
  const host = requestHost(c, 'origin');
  const domainOk = host === null ? null : hostAllowed(host, seal.allowed_domains);
  const state = domainOk === false ? 'domain_mismatch' : status.state;
  const t = now();
  const ttl = Number(c.env.SEAL_TTL_SECONDS || '600');
  const payload = {
    iss: c.env.PUBLIC_ORIGIN,
    sub: seal.id,
    iat: t,
    exp: t + ttl,
    business: { slug: status.business.slug, name: status.business.name },
    domains: seal.allowed_domains,
    requested_by: host,
    state,
    certification: status.certification
      ? { id: status.certification.id, status: status.certification.status, issued_at: status.certification.issued_at, expires_at: status.certification.expires_at }
      : null,
    recent_reviews: { window: status.eligibility.window, considered: status.eligibility.considered, verified: status.eligibility.verified },
    verify_url: `${c.env.PUBLIC_ORIGIN}/s/${seal.id}`,
  };
  return c.json({
    valid: state === 'verified',
    state,
    label: state === 'domain_mismatch' ? 'Not Valid On This Site' : STATE_LABEL[status.state],
    business_name: status.business.name,
    certification_expires_at: status.certification?.expires_at ?? null,
    recent_reviews: payload.recent_reviews,
    verify_url: payload.verify_url,
    attestation: await signJws(c.env.SIGNING_KEY_JWK, payload),
  });
});

pub.get('/v1/seals/:id/badge.svg', async (c) => {
  const { seal, status } = await loadSeal(c, c.req.param('id'));
  let svg: string;
  if (!seal || seal.revoked || !status) svg = badgeSvg({ state: 'unknown' });
  else {
    // <img> requests carry Referer unless the embedding page strips it; when present, enforce the binding.
    const host = requestHost(c, 'referer');
    const mismatch = host !== null && host !== new URL(c.env.PUBLIC_ORIGIN).hostname && !hostAllowed(host, seal.allowed_domains);
    svg = badgeSvg({
      state: mismatch ? 'domain_mismatch' : status.state,
      businessName: status.business.name,
      expiresAt: status.certification?.expires_at,
      verified: status.eligibility.verified,
      considered: status.eligibility.considered,
    });
  }
  return c.body(svg, 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'private, max-age=60',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'cross-origin-resource-policy': 'cross-origin',
    'x-frame-options': '',
  });
});

// Click-through target of every seal.
pub.get('/s/:id', async (c) => {
  const { seal, status } = await loadSeal(c, c.req.param('id'));
  if (!seal || !status) return c.redirect('/verify/unknown', 302);
  return c.redirect(`/verify/${encodeURIComponent(status.business.slug)}?seal=${encodeURIComponent(seal.id)}`, 302);
});

// =====================================================================
// Public verification page
// =====================================================================
pub.get('/verify/:slug', limit('verifypage', 120, 60), async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  const slug = c.req.param('slug');
  const st = /^[a-z0-9-]{3,50}$/.test(slug) ? await businessStatus(c.env, { slug }) : null;
  if (!st) {
    return c.html(page('Not found', `<section class="card"><h1>No certification found</h1><p>TechCatalyst has no record of this business. A seal pointing here is not genuine.</p></section>`), 404);
  }

  const sealId = c.req.query('seal');
  let sealHtml = '';
  if (sealId && /^seal_[a-z2-9]{16}$/.test(sealId)) {
    const s = await c.env.DB.prepare(`SELECT allowed_domains, revoked_at FROM seal_tokens WHERE id = ?1 AND business_id = ?2`)
      .bind(sealId, st.business.id)
      .first<{ allowed_domains: string; revoked_at: number | null }>();
    sealHtml = !s
      ? `<div class="alert bad">This seal ID does not belong to ${esc(st.business.name)}. It may be forged.</div>`
      : s.revoked_at
        ? `<div class="alert bad">This seal has been revoked and should no longer be displayed.</div>`
        : `<div class="alert info"><strong>Check the address bar.</strong> This seal is only valid on: ${(JSON.parse(s.allowed_domains) as string[]).map((d) => `<code>${esc(d)}</code>`).join(', ')}. If you arrived from any other site, the seal was copied.</div>`;
  }

  const reviews = await c.env.DB.prepare(
    `SELECT rating, title, body, author_name, reviewed_at, source, verification FROM reviews
      WHERE business_id = ?1 AND status = 'approved' ORDER BY reviewed_at DESC LIMIT ?2`
  )
    .bind(st.business.id, st.eligibility.window)
    .all<{ rating: number; title: string | null; body: string; author_name: string | null; reviewed_at: number; source: string; verification: string }>();

  const e = st.eligibility;
  const cert = st.certification;
  const tone = st.state === 'verified' ? 'good' : st.state === 'under_review' || st.state === 'not_certified' ? 'warn' : 'bad';
  const explain: Record<string, string> = {
    verified: `TechCatalyst checked the ${e.considered} most recent reviews and ${e.verified} are verified, meeting this certificate's bar of ${Math.round(e.minRatio * 100)}%.`,
    under_review: `The certificate is active, but only ${e.verified} of the ${e.considered} most recent reviews are verified right now (bar: ${Math.round(e.minRatio * 100)}%, minimum ${e.minReviews}). New reviews may still be in audit.`,
    expired: 'The certificate has expired and has not been renewed.',
    suspended: `Certification is suspended${cert?.status_reason ? `: ${cert.status_reason}` : ''}.`,
    revoked: `Certification was revoked${cert?.status_reason ? `: ${cert.status_reason}` : ''}.`,
    not_certified: 'This business is registered but has not been certified.',
  };

  const reviewList = (reviews.results ?? [])
    .map(
      (r) => `<li class="review">
  <div class="review-head"><span class="stars" aria-label="${r.rating} of 5">${stars(r.rating)}</span>
  <span class="tag ${r.verification === 'transaction' ? 'good' : 'info'}">${r.verification === 'transaction' ? 'Verified purchase' : 'Audited · ' + esc(r.source)}</span>
  <span class="muted">${fmtDate(r.reviewed_at)}</span></div>
  ${r.title ? `<strong>${esc(r.title)}</strong>` : ''}
  <p>${esc(r.body)}</p>
  <span class="muted">— ${esc(r.author_name || 'Verified customer')}</span>
</li>`
    )
    .join('');

  return c.html(
    page(
      `${st.business.name} · TechCatalyst verification`,
      `${sealHtml}
<section class="card status ${tone}">
  <p class="eyebrow">Review verification status</p>
  <h1>${esc(st.business.name)}</h1>
  <p class="state">${esc(STATE_LABEL[st.state])}</p>
  <p>${esc(explain[st.state])}</p>
  <dl class="facts">
    <div><dt>Website</dt><dd><code>${esc(st.business.website)}</code></dd></div>
    <div><dt>Certificate</dt><dd>${cert ? `<code>${esc(cert.id)}</code>` : '—'}</dd></div>
    <div><dt>Issued</dt><dd>${fmtDate(cert?.issued_at)}</dd></div>
    <div><dt>Valid until</dt><dd>${fmtDate(cert?.expires_at)}</dd></div>
    <div><dt>Recent reviews verified</dt><dd>${e.verified} / ${e.considered}</dd></div>
    <div><dt>Checked</dt><dd>${esc(new Date().toUTCString())}</dd></div>
  </dl>
</section>
<section class="card">
  <h2>Most recent verified reviews</h2>
  ${reviewList ? `<ul class="reviews">${reviewList}</ul>` : '<p class="muted">No verified reviews yet.</p>'}
</section>`
    )
  );
});

// =====================================================================
// Invitation review form (the customer side of transaction verification)
// =====================================================================
async function findInvite(env: Env, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT i.id, i.business_id, i.email, i.customer_name, i.created_at, i.expires_at, i.used_at, b.name AS business_name, b.status AS biz_status
       FROM invitations i JOIN businesses b ON b.id = i.business_id WHERE i.token_hash = ?1`
  )
    .bind(await sha256Hex(token))
    .first<{ id: string; business_id: string; email: string | null; customer_name: string | null; created_at: number; expires_at: number; used_at: number | null; business_name: string; biz_status: string }>();
}

function inviteProblem(inv: Awaited<ReturnType<typeof findInvite>>): string | null {
  if (!inv || inv.biz_status !== 'active') return 'This review link is not valid.';
  if (inv.used_at) return 'A review has already been submitted with this link. Thank you!';
  if (inv.expires_at < now()) return 'This review link has expired.';
  return null;
}

function reviewForm(inv: NonNullable<Awaited<ReturnType<typeof findInvite>>>, token: string, error?: string, v: Record<string, string> = {}) {
  const radios = [5, 4, 3, 2, 1]
    .map((n) => `<label class="rate"><input type="radio" name="rating" value="${n}" ${v.rating === String(n) ? 'checked' : ''} required><span>${stars(n)}</span></label>`)
    .join('');
  return page(
    `Review ${inv.business_name}`,
    `<section class="card">
  <p class="eyebrow">Independent review · collected by TechCatalyst</p>
  <h1>How was your experience with ${esc(inv.business_name)}?</h1>
  <p class="muted">Your review is tied to a real purchase, which is why it carries a "Verified purchase" mark. ${esc(inv.business_name)} cannot edit it.</p>
  ${error ? `<div class="alert bad">${esc(error)}</div>` : ''}
  <form method="post" action="/review/${esc(token)}" class="form">
    <fieldset class="ratings"><legend>Rating</legend>${radios}</fieldset>
    <label>Title <span class="muted">(optional)</span><input name="title" maxlength="120" value="${esc(v.title)}"></label>
    <label>Your review<textarea name="body" required minlength="10" maxlength="3000" rows="6">${esc(v.body)}</textarea></label>
    <label>Name to show<input name="author_name" maxlength="60" value="${esc(v.author_name ?? inv.customer_name ?? '')}" placeholder="e.g. Maria G."></label>
    <button type="submit" class="btn primary">Submit review</button>
  </form>
</section>`
  );
}

pub.get('/review/:token', limit('reviewform', 60, 300), async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('Referrer-Policy', 'no-referrer'); // never leak the token
  c.header('Cache-Control', 'no-store');
  const token = c.req.param('token');
  const inv = await findInvite(c.env, token);
  const problem = inviteProblem(inv);
  if (problem) return c.html(page('Review', `<section class="card"><h1>${esc(problem)}</h1></section>`), inv ? 410 : 404);
  return c.html(reviewForm(inv!, token));
});

pub.post('/review/:token', limit('reviewsubmit', 10, 600), async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  assertSameOrigin(c);
  const token = c.req.param('token');
  const inv = await findInvite(c.env, token);
  const problem = inviteProblem(inv);
  if (problem) return c.html(page('Review', `<section class="card"><h1>${esc(problem)}</h1></section>`), inv ? 410 : 404);

  const form = await c.req.parseBody();
  const raw = {
    rating: String(form.rating ?? ''),
    title: String(form.title ?? '').trim(),
    body: String(form.body ?? '').trim(),
    author_name: String(form.author_name ?? '').trim(),
  };
  const rating = Number.parseInt(raw.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return c.html(reviewForm(inv!, token, 'Please choose a rating.', raw), 400);
  if (raw.body.length < 10 || raw.body.length > 3000) return c.html(reviewForm(inv!, token, 'Please write between 10 and 3000 characters.', raw), 400);
  if (raw.title.length > 120 || raw.author_name.length > 60) return c.html(reviewForm(inv!, token, 'Title or name is too long.', raw), 400);

  const ipHash = c.get('ipHash');
  const uaHash = await hmacHex(c.env.HASH_SECRET, `ua:${c.req.header('user-agent') ?? ''}`);
  const fraud = await scoreReview(c.env, {
    businessId: inv!.business_id,
    body: raw.body,
    rating,
    ipHash,
    uaHash,
    emailDomain: inv!.email?.split('@')[1] ?? null,
    inviteCreatedAt: inv!.created_at,
  });
  const status = fraud.score >= HOLD_THRESHOLD ? 'held' : fraud.score <= AUTO_APPROVE_MAX ? 'approved' : 'pending';
  const verification = status === 'approved' ? 'transaction' : 'none';
  const t = now();

  // Claim the invitation atomically so a link can only ever produce one review.
  const claim = await c.env.DB.prepare(`UPDATE invitations SET used_at = ?1, email = NULL WHERE id = ?2 AND used_at IS NULL`).bind(t, inv!.id).run();
  if (!claim.meta.changes) return c.html(page('Review', `<section class="card"><h1>A review was already submitted with this link.</h1></section>`), 409);

  const revId = id('rev');
  await c.env.DB.prepare(
    `INSERT INTO reviews (id, business_id, source, external_id, invitation_id, rating, title, body, author_name, reviewed_at, status, verification,
                          fraud_score, fraud_flags, ip_hash, ua_hash, created_at, decided_by, decided_at)
     VALUES (?1, ?2, 'invite', ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?8, ?15, ?16)`
  )
    .bind(revId, inv!.business_id, inv!.id, rating, raw.title || null, raw.body, raw.author_name || null, t, status, verification,
      fraud.score, JSON.stringify(fraud.flags), ipHash, uaHash, status === 'approved' ? 'system:auto' : null, status === 'approved' ? t : null)
    .run();
  await audit(c.env, 'public', 'review.submit', revId, { invitation: inv!.id, status, fraud_score: fraud.score }, ipHash);

  return c.html(
    page('Thank you', `<section class="card"><h1>Thank you!</h1><p>Your review of ${esc(inv!.business_name)} has been received${status === 'approved' ? ' and published' : ' and will be published after a routine check'}.</p></section>`)
  );
});

pub.get('/health', (c) => c.json({ ok: true }));

export default pub;
