// Crypto primitives — all WebCrypto, no third-party crypto code.
const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes
/** Random identifier with a type prefix, e.g. id('biz') -> biz_7hq3...  (~80 bits). */
export function id(prefix: string, len = 16): string {
  const bytes = randomBytes(len);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return `${prefix}_${out}`;
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = hmacKeyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeyCache.set(secret, k);
  }
  return k;
}
/** Keyed hash for PII we must correlate but never reverse (IPs, emails). */
export async function hmacHex(secret: string, input: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(input));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (equal-length hex digests). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- API keys ----------
// Shown once:  tck_<keyid>.<secret>   (secret = 256 bits)
export async function newApiKey() {
  const keyId = id('key', 12);
  const secret = randomToken(32);
  return { keyId, token: `tck_${keyId}.${secret}`, secretHash: await sha256Hex(secret) };
}
export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  const m = /^tck_(key_[a-z2-9]{12})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
  return m ? { keyId: m[1], secret: m[2] } : null;
}

// ---------- Attestation signing (ES256 JWS) ----------
let signingKey: Promise<{ key: CryptoKey; kid: string; publicJwk: JsonWebKey }> | null = null;
let signingKeySrc = '';

export function getSigningKey(jwkJson: string) {
  if (!signingKey || signingKeySrc !== jwkJson) {
    signingKeySrc = jwkJson;
    signingKey = (async () => {
      if (!jwkJson) throw new Error('SIGNING_KEY_JWK is not configured');
      const jwk = JSON.parse(jwkJson) as JsonWebKey & { kid?: string };
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('SIGNING_KEY_JWK must be an EC P-256 private JWK');
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
      const kid = jwk.kid || (await sha256Hex(`${jwk.x}.${jwk.y}`)).slice(0, 16);
      return { key, kid, publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'ES256' } as JsonWebKey };
    })();
  }
  return signingKey;
}

export async function signJws(jwkJson: string, payload: Record<string, unknown>): Promise<string> {
  const { key, kid } = await getSigningKey(jwkJson);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`; // WebCrypto ECDSA output is already raw r||s (JWS format)
}
