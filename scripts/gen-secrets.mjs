// Generates the secrets this service needs. Prints them; never writes them to disk unless --dev-vars is passed.
//   node scripts/gen-secrets.mjs              -> print values to paste into `wrangler secret put`
//   node scripts/gen-secrets.mjs --dev-vars   -> write .dev.vars for local development
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const kidBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jwk.x}.${jwk.y}`)));
jwk.kid = [...kidBytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
delete jwk.key_ops;
delete jwk.ext;

const rand = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
const secrets = {
  SIGNING_KEY_JWK: JSON.stringify(jwk),
  HASH_SECRET: rand(32),
  BOOTSTRAP_TOKEN: rand(32),
};

if (process.argv.includes('--dev-vars')) {
  if (existsSync('.dev.vars')) {
    console.error('.dev.vars already exists; delete it first.');
    process.exit(1);
  }
  writeFileSync('.dev.vars', Object.entries(secrets).map(([k, v]) => `${k}='${v}'`).join('\n') + '\nPUBLIC_ORIGIN=http://localhost:8787\n', { mode: 0o600 });
  console.log('Wrote .dev.vars (gitignored). BOOTSTRAP_TOKEN:', secrets.BOOTSTRAP_TOKEN);
} else {
  for (const [k, v] of Object.entries(secrets)) console.log(`${k}=${v}\n`);
  console.log('Set each with: npx wrangler secret put <NAME>   (paste the value when prompted)');
}
