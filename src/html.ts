// Server-rendered pages. Every interpolated value goes through esc(); no inline scripts.
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const PAGE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function page(title: string, body: string, opts: { scripts?: string[] } = {}): string {
  const scripts = (opts.scripts ?? []).map((s) => `<script src="${esc(s)}" defer></script>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/app.css">
${scripts}
</head>
<body>
<header class="topbar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>TechCatalyst <span class="muted">Review Seal</span></a></header>
<main class="wrap">${body}</main>
<footer class="foot muted">Attestations are signed by TechCatalyst and checked live on every view.</footer>
</body>
</html>`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function stars(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}
