import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from './env';
import { now } from './env';
import { HttpError, ipHashMiddleware, securityHeaders } from './security';
import admin from './routes/admin';
import business from './routes/business';
import pub from './routes/public';

const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.use('*', ipHashMiddleware);
app.use('*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));

// The private API never answers cross-origin browser reads (no CORS headers) — only /v1/seals is public.
app.route('/v1/admin', admin);
app.route('/v1/business', business);
app.route('/', pub);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
  console.error('unhandled', err);
  return c.json({ error: 'internal_error' }, 500); // never leak internals
});

export default {
  fetch: app.fetch,

  // Housekeeping (hourly)
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(t),
      env.DB.prepare(`DELETE FROM rate_limits WHERE expires_at < ?1`).bind(t),
      // Data minimization: drop plaintext emails once an invite can no longer be used.
      env.DB.prepare(`UPDATE invitations SET email = NULL WHERE email IS NOT NULL AND (used_at IS NOT NULL OR expires_at < ?1)`).bind(t),
    ]);
  },
} satisfies ExportedHandler<Env>;
