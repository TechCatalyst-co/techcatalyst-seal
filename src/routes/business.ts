import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { now } from '../env';
import { hmacHex, id, newApiKey, randomToken, sha256Hex } from '../crypto';
import { HttpError, audit, normalizeDomain, rateLimit, requireRole } from '../security';
import { businessStatus } from '../status';
import { scoreReview } from '../fraud';
import { sendInvite } from '../mail';
import { parse } from '../validate';

const biz = new Hono<AppEnv>();
biz.use('*', requireRole('business'));

const bizId = (c: { get: (k: 'principal') => { businessId: string | null } }) => c.get('principal').businessId!;

biz.get('/me', async (c) => {
  const st = await businessStatus(c.env, { id: bizId(c) });
  if (!st) throw new HttpError(404, 'not_found');
  return c.json(st);
});

// ---------- Review invitations (transaction-verified) ----------
biz.post('/invitations', async (c) => {
  const businessId = bizId(c);
  await rateLimit(c.env, 'invites', businessId, 2000, 86400);
  const body = parse(
    z.object({
      orders: z
        .array(
          z.object({
            order_ref: z.string().trim().min(1).max(100),
            email: z.string().trim().toLowerCase().email().max(254),
            customer_name: z.string().trim().max(80).optional(),
            purchased_at: z.number().int().optional(),
          })
        )
        .min(1)
        .max(100),
    }),
    await c.req.json()
  );
  const b = await c.env.DB.prepare(`SELECT name FROM businesses WHERE id = ?1`).bind(businessId).first<{ name: string }>();
  const t = now();
  const ttl = Number(c.env.INVITE_TTL_DAYS || '30') * 86400;
  const results: Array<Record<string, unknown>> = [];

  for (const o of body.orders) {
    const token = randomToken(32);
    const invId = id('inv');
    const link = `${c.env.PUBLIC_ORIGIN}/review/${token}`;
    try {
      await c.env.DB.prepare(
        `INSERT INTO invitations (id, business_id, order_ref, email_hash, email, customer_name, token_hash, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
        .bind(invId, businessId, o.order_ref, await hmacHex(c.env.HASH_SECRET, `email:${o.email}`), o.email, o.customer_name ?? null,
          await sha256Hex(token), t, t + ttl)
        .run();
    } catch (e) {
      if (String(e).includes('UNIQUE')) {
        results.push({ order_ref: o.order_ref, status: 'duplicate_order' });
        continue;
      }
      throw e;
    }
    const sent = await sendInvite(c.env, o.email, b!.name, o.customer_name ?? null, link);
    if (sent) await c.env.DB.prepare(`UPDATE invitations SET sent_at = ?1 WHERE id = ?2`).bind(now(), invId).run();
    // When we don't send email ourselves, the business delivers the link. It is single-use and expires.
    results.push({ order_ref: o.order_ref, id: invId, status: sent ? 'emailed' : 'created', ...(sent ? {} : { link }) });
  }
  await audit(c.env, c.get('principal').keyId, 'invitations.create', businessId, { count: body.orders.length }, c.get('ipHash'));
  return c.json({ invitations: results }, 201);
});

biz.get('/invitations', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, order_ref, customer_name, created_at, expires_at, sent_at, used_at FROM invitations WHERE business_id = ?1 ORDER BY created_at DESC LIMIT 200`
  )
    .bind(bizId(c))
    .all();
  return c.json({ invitations: rows.results });
});

// ---------- Imported reviews (Google / Yelp / CSV) → analyst audit ----------
biz.post('/reviews/import', async (c) => {
  const businessId = bizId(c);
  await rateLimit(c.env, 'imports', businessId, 5000, 86400);
  const body = parse(
    z.object({
      reviews: z
        .array(
          z.object({
            source: z.enum(['google', 'yelp', 'facebook', 'csv', 'other']),
            external_id: z.string().trim().min(1).max(200),
            rating: z.number().int().min(1).max(5),
            title: z.string().trim().max(200).optional(),
            body: z.string().trim().min(1).max(5000),
            author_name: z.string().trim().max(80).optional(),
            reviewed_at: z.number().int().min(946684800).max(now() + 86400),
          })
        )
        .min(1)
        .max(200),
    }),
    await c.req.json()
  );
  let inserted = 0;
  let duplicates = 0;
  let held = 0;
  for (const r of body.reviews) {
    const fraud = await scoreReview(c.env, { businessId, body: r.body, rating: r.rating });
    const status = fraud.score >= 50 ? 'held' : 'pending'; // imports always need a human
    try {
      await c.env.DB.prepare(
        `INSERT INTO reviews (id, business_id, source, external_id, rating, title, body, author_name, reviewed_at, status, verification, fraud_score, fraud_flags, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'none', ?11, ?12, ?13)`
      )
        .bind(id('rev'), businessId, r.source, r.external_id, r.rating, r.title ?? null, r.body, r.author_name ?? null, r.reviewed_at,
          status, fraud.score, JSON.stringify(fraud.flags), now())
        .run();
      inserted++;
      if (status === 'held') held++;
    } catch (e) {
      if (String(e).includes('UNIQUE')) duplicates++;
      else throw e;
    }
  }
  await audit(c.env, c.get('principal').keyId, 'reviews.import', businessId, { inserted, duplicates, held }, c.get('ipHash'));
  return c.json({ inserted, duplicates, held }, 201);
});

biz.get('/reviews', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, source, external_id, rating, title, body, author_name, reviewed_at, status, verification, created_at
       FROM reviews WHERE business_id = ?1 ORDER BY reviewed_at DESC LIMIT 200`
  )
    .bind(bizId(c))
    .all();
  // Fraud scores/flags stay internal so they can't be used to tune fake reviews.
  return c.json({ reviews: rows.results });
});

// ---------- Seal tokens (domain-bound site keys) ----------
biz.get('/seals', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, allowed_domains, created_at, revoked_at FROM seal_tokens WHERE business_id = ?1 ORDER BY created_at DESC`)
    .bind(bizId(c))
    .all<{ id: string; allowed_domains: string; created_at: number; revoked_at: number | null }>();
  return c.json({ seals: (rows.results ?? []).map((s) => ({ ...s, allowed_domains: JSON.parse(s.allowed_domains) })) });
});

biz.post('/seals', async (c) => {
  const businessId = bizId(c);
  const body = parse(z.object({ domains: z.array(z.string().max(253)).min(1).max(10) }), await c.req.json());
  const b = await c.env.DB.prepare(`SELECT website FROM businesses WHERE id = ?1`).bind(businessId).first<{ website: string }>();
  const domains = [...new Set(body.domains.map(normalizeDomain))];
  if (domains.some((d) => !d)) throw new HttpError(400, 'invalid_domain');
  // A business may only bind seals to its registered website (and its subdomains).
  // Additional domains must be added by an admin after ownership verification.
  for (const d of domains as string[]) {
    if (!(d === b!.website || d.endsWith(`.${b!.website}`))) {
      throw new HttpError(403, 'domain_not_registered', `${d} is not under ${b!.website}. Ask TechCatalyst to verify additional domains.`);
    }
  }
  const active = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM seal_tokens WHERE business_id = ?1 AND revoked_at IS NULL`).bind(businessId).first<{ n: number }>();
  if ((active?.n ?? 0) >= 10) throw new HttpError(409, 'too_many_seals', 'Revoke an unused seal first.');
  const sealId = id('seal');
  await c.env.DB.prepare(`INSERT INTO seal_tokens (id, business_id, allowed_domains, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(sealId, businessId, JSON.stringify(domains), now())
    .run();
  await audit(c.env, c.get('principal').keyId, 'seal.create', sealId, { domains }, c.get('ipHash'));
  return c.json({ id: sealId, allowed_domains: domains, embed: embedSnippet(c.env.PUBLIC_ORIGIN, sealId) }, 201);
});

biz.delete('/seals/:id', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE seal_tokens SET revoked_at = ?1 WHERE id = ?2 AND business_id = ?3 AND revoked_at IS NULL`)
    .bind(now(), c.req.param('id'), bizId(c))
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await audit(c.env, c.get('principal').keyId, 'seal.revoke', c.req.param('id'), null, c.get('ipHash'));
  return c.json({ ok: true });
});

// ---------- Business self-service keys ----------
biz.get('/keys', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, label, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE business_id = ?1 ORDER BY created_at DESC`)
    .bind(bizId(c))
    .all();
  return c.json({ keys: rows.results, current: c.get('principal').keyId });
});

biz.post('/keys', async (c) => {
  const businessId = bizId(c);
  const body = parse(z.object({ label: z.string().trim().min(2).max(80), expires_in_days: z.number().int().min(1).max(730).optional() }), await c.req.json());
  const active = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE business_id = ?1 AND revoked_at IS NULL`).bind(businessId).first<{ n: number }>();
  if ((active?.n ?? 0) >= 10) throw new HttpError(409, 'too_many_keys', 'Revoke an unused key first.');
  const k = await newApiKey();
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, secret_hash, role, business_id, label, created_by, created_at, expires_at) VALUES (?1, ?2, 'business', ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(k.keyId, k.secretHash, businessId, body.label, c.get('principal').keyId, t, body.expires_in_days ? t + body.expires_in_days * 86400 : null)
    .run();
  await audit(c.env, c.get('principal').keyId, 'key.create', k.keyId, { label: body.label }, c.get('ipHash'));
  return c.json({ id: k.keyId, token: k.token, note: 'Store this token now. It cannot be shown again.' }, 201);
});

biz.delete('/keys/:id', async (c) => {
  const p = c.get('principal');
  if (c.req.param('id') === p.keyId) throw new HttpError(409, 'cannot_revoke_self', 'Create a new key, sign in with it, then revoke this one.');
  const r = await c.env.DB.prepare(`UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND business_id = ?3 AND revoked_at IS NULL`)
    .bind(now(), c.req.param('id'), p.businessId)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await c.env.DB.prepare(`DELETE FROM sessions WHERE key_id = ?1`).bind(c.req.param('id')).run();
  await audit(c.env, p.keyId, 'key.revoke', c.req.param('id'), null, c.get('ipHash'));
  return c.json({ ok: true });
});

export function embedSnippet(origin: string, sealId: string) {
  return {
    script: `<script src="${origin}/embed.js" data-tc-seal="${sealId}" async></script>`,
    image: `<a href="${origin}/s/${sealId}" target="_blank" rel="noopener"><img src="${origin}/v1/seals/${sealId}/badge.svg" width="300" height="64" alt="TechCatalyst review verification seal"></a>`,
  };
}

export default biz;
