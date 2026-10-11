import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, Env, Principal } from './env';
import { now } from './env';
import { hmacHex, parseApiKey, sha256Hex, timingSafeEqual } from './crypto';

export const SESSION_COOKIE = '__Host-tc_session';
export const SESSION_TTL = 8 * 3600;

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? '0.0.0.0';
}

/** Attaches a keyed hash of the client IP (raw IPs are never stored). */
export const ipHashMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('ipHash', await hmacHex(c.env.HASH_SECRET, `ip:${clientIp(c)}`));
  await next();
};

/** Baseline security headers on every Worker response. Static assets get theirs from public/_headers. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (!h.has('Content-Security-Policy')) {
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY');
};

// ---------- Rate limiting (fixed window in D1) ----------
// For production, also add a Cloudflare WAF rate-limiting rule in front; this is defense in depth.
export async function rateLimit(env: Env, name: string, subject: string, limit: number, windowSec: number) {
  const t = now();
  const win = Math.floor(t / windowSec);
  const bucket = `${name}:${subject}:${win}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(bucket, (win + 1) * windowSec)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    throw new HttpError(429, 'rate_limited', 'Too many requests, slow down.');
  }
}

export function limit(name: string, max: number, windowSec: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await rateLimit(c.env, name, c.get('ipHash'), max, windowSec);
    await next();
  };
}

// ---------- Authentication ----------
export async function principalFromKey(env: Env, token: string): Promise<Principal | null> {
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  const row = await env.DB.prepare(
    `SELECT k.id, k.secret_hash, k.role, k.business_id, k.expires_at, k.revoked_at, b.status AS biz_status
       FROM api_keys k LEFT JOIN businesses b ON b.id = k.business_id WHERE k.id = ?1`
  )
    .bind(parsed.keyId)
    .first<{ id: string; secret_hash: string; role: 'admin' | 'business'; business_id: string | null; expires_at: number | null; revoked_at: number | null; biz_status: string | null }>();
  // Always hash, even on miss, so timing doesn't reveal which key ids exist.
  const hash = await sha256Hex(parsed.secret);
  if (!row || !timingSafeEqual(hash, row.secret_hash)) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at < now()) return null;
  if (row.role === 'business' && row.biz_status !== 'active') return null;
  // Throttled last-used update (at most once a minute) to limit write amplification.
  await env.DB.prepare(`UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 60)`)
    .bind(now(), row.id)
    .run();
  return { keyId: row.id, role: row.role, businessId: row.business_id, via: 'bearer' };
}

async function principalFromSession(env: Env, cookie: string): Promise<Principal | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
  const row = await env.DB.prepare(
    `SELECT s.key_id, s.expires_at, k.role, k.business_id, k.revoked_at, k.expires_at AS key_exp, b.status AS biz_status
       FROM sessions s JOIN api_keys k ON k.id = s.key_id LEFT JOIN businesses b ON b.id = k.business_id
      WHERE s.id_hash = ?1`
  )
    .bind(await sha256Hex(cookie))
    .first<{ key_id: string; expires_at: number; role: 'admin' | 'business'; business_id: string | null; revoked_at: number | null; key_exp: number | null; biz_status: string | null }>();
  if (!row || row.expires_at < now() || row.revoked_at) return null;
  if (row.key_exp && row.key_exp < now()) return null;
  if (row.role === 'business' && row.biz_status !== 'active') return null;
  return { keyId: row.key_id, role: row.role, businessId: row.business_id, via: 'session' };
}

export async function resolvePrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const auth = c.req.header('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? principalFromKey(c.env, m[1]) : null;
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? principalFromSession(c.env, cookie) : null;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Cookie-authenticated writes must come from our own origin (CSRF defense on top of SameSite=Strict). */
export function assertSameOrigin(c: Context<AppEnv>) {
  const origin = c.req.header('origin');
  const expected = new URL(c.env.PUBLIC_ORIGIN).origin;
  const self = new URL(c.req.url).origin; // allows local dev
  if (!origin || (origin !== expected && origin !== self)) {
    throw new HttpError(403, 'bad_origin', 'Cross-origin request rejected.');
  }
}

export function requireRole(role: 'admin' | 'business'): MiddlewareHandler<AppEnv> {
  return async (c, next: Next) => {
    // Brute-force guard on authenticated surfaces: failed auths count against the IP.
    const p = await resolvePrincipal(c);
    if (!p) {
      await rateLimit(c.env, 'authfail', c.get('ipHash'), 20, 300);
      throw new HttpError(401, 'unauthorized', 'Valid API key or session required.');
    }
    if (p.role !== role) throw new HttpError(403, 'forbidden', 'This key cannot access that resource.');
    if (p.via === 'session' && UNSAFE.has(c.req.method)) assertSameOrigin(c);
    c.set('principal', p);
    await next();
  };
}

export async function audit(env: Env, actor: string, action: string, target: string | null, details: unknown, ipHash?: string) {
  await env.DB.prepare(`INSERT INTO audit_log (at, actor, action, target, details, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(now(), actor, action, target, details === undefined ? null : JSON.stringify(details), ipHash ?? null)
    .run();
}

/** Normalize & validate a hostname a business wants to display the seal on. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/\.$/, '');
    if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(host) && host !== 'localhost') return null;
    return host;
  } catch {
    return null;
  }
}

/** True if host equals an allowed domain or is a subdomain of it (www.example.com matches example.com). */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}
