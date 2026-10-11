import type { Env } from './env';
import { esc } from './html';

/** Sends a review invitation. Returns false when no provider is configured (link is handed to the business instead). */
export async function sendInvite(env: Env, to: string, businessName: string, customerName: string | null, link: string): Promise<boolean> {
  if (env.MAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY) return false;
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  const text = `${greeting}\n\n${businessName} asked TechCatalyst to collect an independent review of your recent purchase. It takes a minute:\n\n${link}\n\nThis link is personal and expires in 30 days. TechCatalyst verifies reviews so other customers can trust them.`;
  const html = `<p>${esc(greeting)}</p><p>${esc(businessName)} asked TechCatalyst to collect an independent review of your recent purchase. It takes a minute:</p><p><a href="${esc(link)}">Write your review</a></p><p style="color:#666;font-size:13px">This link is personal and expires in 30 days. TechCatalyst verifies reviews so other customers can trust them.</p>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: `How was your experience with ${businessName}?`, text, html }),
  });
  if (!res.ok) {
    console.error('invite email failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}
