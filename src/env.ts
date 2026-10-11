export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_ORIGIN: string;
  ISSUER_NAME: string;
  SEAL_TTL_SECONDS: string;
  INVITE_TTL_DAYS: string;
  MAIL_PROVIDER: string;
  MAIL_FROM: string;
  SIGNING_KEY_JWK: string;
  HASH_SECRET: string;
  BOOTSTRAP_TOKEN?: string;
  RESEND_API_KEY?: string;
}

export interface Principal {
  keyId: string;
  role: 'admin' | 'business';
  businessId: string | null;
  via: 'bearer' | 'session';
}

export type AppEnv = { Bindings: Env; Variables: { principal: Principal; ipHash: string } };

export const now = () => Math.floor(Date.now() / 1000);
