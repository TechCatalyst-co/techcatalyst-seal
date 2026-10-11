// Heuristic fraud scoring. Not a verdict: it decides whether a human must look first.
import type { Env } from './env';
import { now } from './env';

export interface FraudInput {
  businessId: string;
  body: string;
  rating: number;
  ipHash?: string | null;
  uaHash?: string | null;
  emailDomain?: string | null;
  inviteCreatedAt?: number | null;
}
export interface FraudResult {
  score: number;
  flags: string[];
}

export const HOLD_THRESHOLD = 50; // >= : held for analyst, never auto-approved
export const AUTO_APPROVE_MAX = 25; // invite reviews at or under this are auto-approved

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
  'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'burnermail.io',
]);

function shingles(text: string, n = 3): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export async function scoreReview(env: Env, input: FraudInput): Promise<FraudResult> {
  const flags: string[] = [];
  let score = 0;
  const t = now();

  if (input.ipHash) {
    const dup = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reviews WHERE business_id = ?1 AND ip_hash = ?2 AND created_at > ?3`
    )
      .bind(input.businessId, input.ipHash, t - 30 * 86400)
      .first<{ n: number }>();
    if ((dup?.n ?? 0) > 0) {
      flags.push(`same_ip_${dup!.n}_in_30d`);
      score += 30 + Math.min(20, (dup!.n - 1) * 10);
    }
  }

  const burst = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE business_id = ?1 AND created_at > ?2`)
    .bind(input.businessId, t - 3600)
    .first<{ n: number }>();
  if ((burst?.n ?? 0) >= 10) {
    flags.push(`burst_${burst!.n}_last_hour`);
    score += 20;
  }

  const recent = await env.DB.prepare(
    `SELECT id, body FROM reviews WHERE business_id = ?1 AND status != 'rejected' ORDER BY created_at DESC LIMIT 200`
  )
    .bind(input.businessId)
    .all<{ id: string; body: string }>();
  const mine = shingles(input.body);
  let best = 0;
  let bestId = '';
  for (const r of recent.results ?? []) {
    const s = jaccard(mine, shingles(r.body));
    if (s > best) {
      best = s;
      bestId = r.id;
    }
  }
  if (best >= 0.6) {
    flags.push(`near_duplicate_of:${bestId}:${best.toFixed(2)}`);
    score += 40;
  } else if (best >= 0.4) {
    flags.push(`similar_to:${bestId}:${best.toFixed(2)}`);
    score += 15;
  }

  const len = input.body.trim().length;
  if (len < 20) {
    flags.push('very_short_text');
    score += 10;
  }
  if (/(https?:\/\/|www\.)/i.test(input.body)) {
    flags.push('contains_link');
    score += 15;
  }
  if (input.emailDomain && DISPOSABLE.has(input.emailDomain.toLowerCase())) {
    flags.push('disposable_email');
    score += 30;
  }
  if (input.inviteCreatedAt && t - input.inviteCreatedAt < 60) {
    flags.push('submitted_under_60s_after_invite');
    score += 10;
  }
  if (input.rating === 5 && len < 40) {
    flags.push('five_star_low_effort');
    score += 5;
  }

  return { score: Math.min(100, score), flags };
}
