import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { now } from '../env';
import { id, newApiKey } from '../crypto';
import { HttpError, audit, normalizeDomain, requireRole } from '../security';
import { businessStatus, computeEligibility, DEFAULT_POLICY } from '../status';
import { parse } from '../validate';
import { embedSnippet } from './business';

const admin = new Hono<AppEnv>();
admin.use('*', requireRole('admin'));

const slugRe = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

// ---------- Businesses ----------
admin.get('/businesses', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.slug, b.name, b.website, b.status, b.created_at,
            (SELECT status FROM certifications WHERE business_id = b.id ORDER BY issued_at DESC LIMIT 1) AS cert_status,
            (SELECT expires_at FROM certifications WHERE business_id = b.id ORDER BY issued_at DESC LIMIT 1) AS cert_expires_at,
            (SELECT COUNT(*) FROM reviews WHERE business_id = b.id AND status IN ('pending','held')) AS queue
       FROM businesses b ORDER BY b.created_at DESC LIMIT 500`
  ).all();
  return c.json({ businesses: rows.results });
});

admin.post('/businesses', async (c) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().toLowerCase().regex(slugRe, 'slug: 3-50 chars, a-z 0-9 and dashes'),
      website: z.string().trim().max(253),
      contact_email: z.string().trim().email().max(254).optional(),
    }),
    await c.req.json()
  );
  const host = normalizeDomain(body.website);
  if (!host) throw new HttpError(400, 'invalid_website');
  const bizId = id('biz');
  try {
    await c.env.DB.prepare(
      `INSERT INTO businesses (id, slug, name, website, contact_email, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)`
    )
      .bind(bizId, body.slug, body.name, host, body.contact_email ?? null, now())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'slug_taken');
    throw e;
  }
  await audit(c.env, c.get('principal').keyId, 'business.create', bizId, { slug: body.slug, website: host }, c.get('ipHash'));
  return c.json({ id: bizId, slug: body.slug, website: host }, 201);
});

admin.get('/businesses/:id', async (c) => {
  const st = await businessStatus(c.env, { id: c.req.param('id') });
  if (!st) throw new HttpError(404, 'not_found');
  const [keys, seals, certs] = await Promise.all([
    c.env.DB.prepare(`SELECT id, label, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE business_id = ?1 ORDER BY created_at DESC`).bind(st.business.id).all(),
    c.env.DB.prepare(`SELECT id, allowed_domains, created_at, revoked_at FROM seal_tokens WHERE business_id = ?1 ORDER BY created_at DESC`).bind(st.business.id).all(),
    c.env.DB.prepare(`SELECT * FROM certifications WHERE business_id = ?1 ORDER BY issued_at DESC LIMIT 20`).bind(st.business.id).all(),
  ]);
  return c.json({
    ...st,
    keys: keys.results,
    seals: (seals.results as any[]).map((s) => ({ ...s, allowed_domains: JSON.parse(s.allowed_domains) })),
    certifications: certs.results,
  });
});

admin.patch('/businesses/:id', async (c) => {
  const body = parse(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(500) }), await c.req.json());
  const r = await c.env.DB.prepare(`UPDATE businesses SET status = ?1 WHERE id = ?2`).bind(body.status, c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await audit(c.env, c.get('principal').keyId, `business.${body.status}`, c.req.param('id'), { reason: body.reason }, c.get('ipHash'));
  return c.json({ ok: true });
});

// ---------- Eligibility preview ----------
admin.get('/businesses/:id/eligibility', async (c) => {
  const q = c.req.query();
  const window = clampInt(q.window, 3, 100, DEFAULT_POLICY.window);
  const minReviews = clampInt(q.min_reviews, 1, window, Math.min(DEFAULT_POLICY.minReviews, window));
  const minRatio = clampFloat(q.min_ratio, 0.5, 1, DEFAULT_POLICY.minRatio);
  return c.json(await computeEligibility(c.env, c.req.param('id'), window, minRatio, minReviews));
});

// ---------- Certifications ----------
admin.post('/businesses/:id/certifications', async (c) => {
  const bizId = c.req.param('id');
  const body = parse(
    z.object({
      valid_days: z.number().int().min(1).max(397), // ~13 months max, like TLS certs
      review_window: z.number().int().min(3).max(100).default(DEFAULT_POLICY.window),
      min_verified_ratio: z.number().min(0.5).max(1).default(DEFAULT_POLICY.minRatio),
      min_reviews: z.number().int().min(1).max(100).default(DEFAULT_POLICY.minReviews),
      notes: z.string().trim().max(1000).optional(),
      force: z.boolean().default(false),
    }),
    await c.req.json()
  );
  if (body.min_reviews > body.review_window) throw new HttpError(400, 'min_reviews_exceeds_window');
  const biz = await c.env.DB.prepare(`SELECT id, status FROM businesses WHERE id = ?1`).bind(bizId).first<{ id: string; status: string }>();
  if (!biz) throw new HttpError(404, 'not_found');
  if (biz.status !== 'active') throw new HttpError(409, 'business_not_active');

  const elig = await computeEligibility(c.env, bizId, body.review_window, body.min_verified_ratio, body.min_reviews);
  if (!elig.meets && !body.force) {
    return c.json({ error: 'not_eligible', message: 'Recent reviews do not meet the verification bar.', eligibility: elig }, 409);
  }

  const t = now();
  const certId = id('cert');
  const principal = c.get('principal');
  // Only one active certificate at a time: supersede earlier ones.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE certifications SET status = 'revoked', status_reason = 'superseded', updated_at = ?1 WHERE business_id = ?2 AND status != 'revoked'`).bind(t, bizId),
    c.env.DB.prepare(
      `INSERT INTO certifications (id, business_id, status, issued_at, expires_at, review_window, min_verified_ratio, min_reviews, issued_by, notes, updated_at)
       VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?3)`
    ).bind(certId, bizId, t, t + body.valid_days * 86400, body.review_window, body.min_verified_ratio, body.min_reviews, principal.keyId, body.notes ?? null),
  ]);
  await audit(c.env, principal.keyId, 'certification.issue', certId, { business: bizId, ...body, eligibility: elig }, c.get('ipHash'));
  return c.json({ id: certId, expires_at: t + body.valid_days * 86400, eligibility: elig }, 201);
});

admin.post('/certifications/:id/status', async (c) => {
  const body = parse(z.object({ status: z.enum(['active', 'suspended', 'revoked']), reason: z.string().trim().min(3).max(500) }), await c.req.json());
  const cert = await c.env.DB.prepare(`SELECT id, status FROM certifications WHERE id = ?1`).bind(c.req.param('id')).first<{ status: string }>();
  if (!cert) throw new HttpError(404, 'not_found');
  if (cert.status === 'revoked') throw new HttpError(409, 'revocation_is_final', 'Revoked certificates cannot be reinstated; issue a new one.');
  await c.env.DB.prepare(`UPDATE certifications SET status = ?1, status_reason = ?2, updated_at = ?3 WHERE id = ?4`)
    .bind(body.status, body.reason, now(), c.req.param('id'))
    .run();
  await audit(c.env, c.get('principal').keyId, `certification.${body.status}`, c.req.param('id'), { reason: body.reason }, c.get('ipHash'));
  return c.json({ ok: true });
});

// ---------- Review moderation queue ----------
admin.get('/reviews', async (c) => {
  const status = c.req.query('status') ?? 'queue';
  const businessId = c.req.query('business_id');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === 'queue') where.push(`r.status IN ('pending','held')`);
  else if (['pending', 'held', 'approved', 'rejected'].includes(status)) {
    binds.push(status);
    where.push(`r.status = ?${binds.length}`);
  } else throw new HttpError(400, 'invalid_status');
  if (businessId) {
    binds.push(businessId);
    where.push(`r.business_id = ?${binds.length}`);
  }
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.business_id, b.name AS business_name, r.source, r.external_id, r.invitation_id, r.rating, r.title, r.body,
            r.author_name, r.reviewed_at, r.status, r.verification, r.fraud_score, r.fraud_flags, r.created_at, r.decided_by, r.decided_at, r.decision_note
       FROM reviews r JOIN businesses b ON b.id = r.business_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.fraud_score DESC, r.created_at ASC LIMIT 200`
  )
    .bind(...binds)
    .all();
  return c.json({ reviews: (rows.results as any[]).map((r) => ({ ...r, fraud_flags: JSON.parse(r.fraud_flags) })) });
});

admin.post('/reviews/:id/decision', async (c) => {
  const body = parse(
    z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() }),
    await c.req.json()
  );
  const rev = await c.env.DB.prepare(`SELECT id, source, invitation_id, status FROM reviews WHERE id = ?1`)
    .bind(c.req.param('id'))
    .first<{ id: string; source: string; invitation_id: string | null; status: string }>();
  if (!rev) throw new HttpError(404, 'not_found');
  // Invite reviews keep "transaction" verification; anything else becomes "audited" by a human.
  const verification = body.decision === 'approve' ? (rev.invitation_id ? 'transaction' : 'audited') : 'none';
  const status = body.decision === 'approve' ? 'approved' : 'rejected';
  const p = c.get('principal');
  await c.env.DB.prepare(
    `UPDATE reviews SET status = ?1, verification = ?2, decided_by = ?3, decided_at = ?4, decision_note = ?5 WHERE id = ?6`
  )
    .bind(status, verification, p.keyId, now(), body.note ?? null, rev.id)
    .run();
  await audit(c.env, p.keyId, `review.${body.decision}`, rev.id, { from: rev.status, note: body.note }, c.get('ipHash'));
  return c.json({ ok: true, status, verification });
});

// ---------- Seals (admins may bind any domain after verifying ownership out of band) ----------
admin.post('/businesses/:id/seals', async (c) => {
  const businessId = c.req.param('id');
  const body = parse(z.object({ domains: z.array(z.string().max(253)).min(1).max(10), ownership_note: z.string().trim().min(3).max(500) }), await c.req.json());
  const b = await c.env.DB.prepare(`SELECT id FROM businesses WHERE id = ?1`).bind(businessId).first();
  if (!b) throw new HttpError(404, 'not_found');
  const domains = [...new Set(body.domains.map(normalizeDomain))];
  if (domains.some((d) => !d)) throw new HttpError(400, 'invalid_domain');
  const sealId = id('seal');
  await c.env.DB.prepare(`INSERT INTO seal_tokens (id, business_id, allowed_domains, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(sealId, businessId, JSON.stringify(domains), now())
    .run();
  await audit(c.env, c.get('principal').keyId, 'seal.create', sealId, { domains, ownership_note: body.ownership_note }, c.get('ipHash'));
  return c.json({ id: sealId, allowed_domains: domains, embed: embedSnippet(c.env.PUBLIC_ORIGIN, sealId) }, 201);
});

admin.delete('/seals/:id', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE seal_tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`).bind(now(), c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await audit(c.env, c.get('principal').keyId, 'seal.revoke', c.req.param('id'), null, c.get('ipHash'));
  return c.json({ ok: true });
});

// ---------- API keys ----------
admin.post('/keys', async (c) => {
  const body = parse(
    z.object({
      role: z.enum(['admin', 'business']),
      business_id: z.string().optional(),
      label: z.string().trim().min(2).max(80),
      expires_in_days: z.number().int().min(1).max(730).optional(),
    }),
    await c.req.json()
  );
  if (body.role === 'business') {
    if (!body.business_id) throw new HttpError(400, 'business_id_required');
    const b = await c.env.DB.prepare(`SELECT id FROM businesses WHERE id = ?1`).bind(body.business_id).first();
    if (!b) throw new HttpError(404, 'business_not_found');
  }
  const k = await newApiKey();
  const t = now();
  const p = c.get('principal');
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, secret_hash, role, business_id, label, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(k.keyId, k.secretHash, body.role, body.role === 'business' ? body.business_id : null, body.label, p.keyId, t,
      body.expires_in_days ? t + body.expires_in_days * 86400 : null)
    .run();
  await audit(c.env, p.keyId, 'key.create', k.keyId, { role: body.role, business_id: body.business_id, label: body.label }, c.get('ipHash'));
  return c.json({ id: k.keyId, token: k.token, note: 'Store this token now. It cannot be shown again.' }, 201);
});

admin.get('/keys', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, role, business_id, label, created_by, created_at, expires_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC LIMIT 500`
  ).all();
  return c.json({ keys: rows.results });
});

admin.delete('/keys/:id', async (c) => {
  const p = c.get('principal');
  const keyId = c.req.param('id');
  if (keyId === p.keyId) throw new HttpError(409, 'cannot_revoke_self', 'Use another admin key to revoke this one.');
  const t = now();
  const r = await c.env.DB.prepare(`UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`).bind(t, keyId).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found_or_revoked');
  await c.env.DB.prepare(`DELETE FROM sessions WHERE key_id = ?1`).bind(keyId).run();
  await audit(c.env, p.keyId, 'key.revoke', keyId, null, c.get('ipHash'));
  return c.json({ ok: true });
});

// ---------- Audit ----------
admin.get('/audit', async (c) => {
  const before = clampInt(c.req.query('before'), 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const rows = await c.env.DB.prepare(`SELECT id, at, actor, action, target, details FROM audit_log WHERE id < ?1 ORDER BY id DESC LIMIT 100`)
    .bind(before)
    .all();
  return c.json({ entries: rows.results });
});

function clampInt(v: string | undefined, min: number, max: number, dflt: number) {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function clampFloat(v: string | undefined, min: number, max: number, dflt: number) {
  const n = v === undefined ? NaN : Number.parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

export default admin;
