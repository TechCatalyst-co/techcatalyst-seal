// Live certification status: the single source of truth for seals, the verify page and portals.
import type { Env } from './env';
import { now } from './env';

export type SealState =
  | 'verified'        // active cert, not expired, last N reviews meet the bar
  | 'under_review'    // active cert, but recent reviews currently fall short
  | 'expired'
  | 'suspended'
  | 'revoked'
  | 'not_certified';

export interface Eligibility {
  window: number;
  considered: number;
  verified: number;
  pending: number;
  ratio: number;
  meets: boolean;
  minReviews: number;
  minRatio: number;
}

export interface BusinessStatus {
  business: { id: string; slug: string; name: string; website: string; status: string };
  state: SealState;
  certification: null | {
    id: string; status: string; issued_at: number; expires_at: number;
    review_window: number; min_verified_ratio: number; min_reviews: number; status_reason: string | null;
  };
  eligibility: Eligibility;
}

export const DEFAULT_POLICY = { window: 10, minRatio: 1.0, minReviews: 5 };

/**
 * Of the business's most recent N reviews (rejected ones excluded — those were caught and removed),
 * how many are approved with transaction or audit verification?
 */
export async function computeEligibility(env: Env, businessId: string, window: number, minRatio: number, minReviews: number): Promise<Eligibility> {
  const rows = await env.DB.prepare(
    `SELECT status, verification FROM reviews
      WHERE business_id = ?1 AND status != 'rejected'
      ORDER BY reviewed_at DESC, created_at DESC LIMIT ?2`
  )
    .bind(businessId, window)
    .all<{ status: string; verification: string }>();
  const list = rows.results ?? [];
  const verified = list.filter((r) => r.status === 'approved' && r.verification !== 'none').length;
  const pending = list.filter((r) => r.status === 'pending' || r.status === 'held').length;
  const considered = list.length;
  const ratio = considered ? verified / considered : 0;
  return {
    window, considered, verified, pending,
    ratio: Math.round(ratio * 1000) / 1000,
    meets: considered >= minReviews && ratio + 1e-9 >= minRatio,
    minReviews, minRatio,
  };
}

export async function businessStatus(env: Env, by: { id?: string; slug?: string }): Promise<BusinessStatus | null> {
  const biz = await env.DB.prepare(
    `SELECT id, slug, name, website, status FROM businesses WHERE ${by.id ? 'id' : 'slug'} = ?1`
  )
    .bind(by.id ?? by.slug)
    .first<BusinessStatus['business']>();
  if (!biz) return null;

  const cert = await env.DB.prepare(
    `SELECT id, status, issued_at, expires_at, review_window, min_verified_ratio, min_reviews, status_reason
       FROM certifications WHERE business_id = ?1 ORDER BY issued_at DESC LIMIT 1`
  )
    .bind(biz.id)
    .first<NonNullable<BusinessStatus['certification']>>();

  const policy = cert
    ? { window: cert.review_window, minRatio: cert.min_verified_ratio, minReviews: cert.min_reviews }
    : DEFAULT_POLICY;
  const eligibility = await computeEligibility(env, biz.id, policy.window, policy.minRatio, policy.minReviews);

  let state: SealState;
  if (!cert) state = 'not_certified';
  else if (biz.status === 'suspended' || cert.status === 'suspended') state = 'suspended';
  else if (cert.status === 'revoked') state = 'revoked';
  else if (cert.expires_at <= now()) state = 'expired';
  else state = eligibility.meets ? 'verified' : 'under_review';

  return { business: biz, state, certification: cert ?? null, eligibility };
}

export const STATE_LABEL: Record<SealState, string> = {
  verified: 'Reviews Verified',
  under_review: 'Verification Under Review',
  expired: 'Certification Expired',
  suspended: 'Certification Suspended',
  revoked: 'Certification Revoked',
  not_certified: 'Not Certified',
};
