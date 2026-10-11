// Server-rendered SVG seal (used for <img>/<noscript> embeds). Text is escaped; no scripts in the SVG.
import { esc, fmtDate } from './html';
import type { SealState } from './status';

const COLORS: Record<string, { bg: string; fg: string; accent: string }> = {
  verified: { bg: '#0f2a1d', fg: '#e8fff2', accent: '#34d399' },
  under_review: { bg: '#2b2410', fg: '#fff7df', accent: '#fbbf24' },
  bad: { bg: '#2c1214', fg: '#ffecec', accent: '#f87171' },
  neutral: { bg: '#1c1f26', fg: '#eef1f6', accent: '#94a3b8' },
};

export function badgeSvg(opts: {
  state: SealState | 'domain_mismatch' | 'unknown';
  businessName?: string;
  expiresAt?: number | null;
  verified?: number;
  considered?: number;
}): string {
  const { state } = opts;
  const palette =
    state === 'verified' ? COLORS.verified :
    state === 'under_review' ? COLORS.under_review :
    state === 'unknown' || state === 'not_certified' ? COLORS.neutral : COLORS.bad;

  const title =
    state === 'verified' ? 'Reviews Verified' :
    state === 'under_review' ? 'Verification Under Review' :
    state === 'expired' ? 'Certification Expired' :
    state === 'suspended' ? 'Certification Suspended' :
    state === 'revoked' ? 'Certification Revoked' :
    state === 'domain_mismatch' ? 'Not Valid On This Site' :
    state === 'unknown' ? 'Seal Not Found' : 'Not Certified';

  const line2 =
    state === 'verified' && opts.expiresAt
      ? `Last ${opts.verified}/${opts.considered} verified · Valid until ${fmtDate(opts.expiresAt)}`
      : state === 'domain_mismatch'
        ? 'This seal belongs to a different website'
        : opts.businessName ?? 'Click to check status';

  const icon =
    state === 'verified'
      ? `<path d="M22 31.5l5.5 5.5L39 25.5" fill="none" stroke="${palette.accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M30.5 23v10M30.5 38.5v.5" fill="none" stroke="${palette.accent}" stroke-width="3.2" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="64" viewBox="0 0 300 64" role="img" aria-label="${esc(`TechCatalyst: ${title}`)}">
<title>${esc(`TechCatalyst — ${title}`)}</title>
<rect x="0.5" y="0.5" width="299" height="63" rx="10" fill="${palette.bg}" stroke="${palette.accent}" stroke-opacity=".55"/>
<path d="M30.5 12l14 5.2v10.6c0 9-6 15.8-14 18.7-8-2.9-14-9.7-14-18.7V17.2z" fill="none" stroke="${palette.accent}" stroke-width="2.2" stroke-linejoin="round" transform="translate(0 2)"/>
${icon}
<text x="58" y="22" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="10" letter-spacing="1.2" fill="${palette.accent}" font-weight="700">TECHCATALYST</text>
<text x="58" y="39" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="15" fill="${palette.fg}" font-weight="700">${esc(title)}</text>
<text x="58" y="54" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="10" fill="${palette.fg}" fill-opacity=".72">${esc(line2.length > 48 ? line2.slice(0, 47) + '…' : line2)}</text>
</svg>`;
}
