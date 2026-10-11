-- TechCatalyst Review Seal — initial schema (Cloudflare D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE businesses (
  id            TEXT PRIMARY KEY,               -- biz_xxx
  slug          TEXT NOT NULL UNIQUE,           -- public, used in verify URL
  name          TEXT NOT NULL,
  website       TEXT NOT NULL,
  contact_email TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    INTEGER NOT NULL
);

-- API keys: secret is never stored, only SHA-256 of it.
-- Format shown once to the holder:  tck_<key_id>.<secret>
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,               -- key_id (public half)
  secret_hash   TEXT NOT NULL,                  -- hex SHA-256 of secret
  role          TEXT NOT NULL CHECK (role IN ('admin','business')),
  business_id   TEXT REFERENCES businesses(id),
  label         TEXT NOT NULL,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                        -- optional hard expiry
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  CHECK ((role = 'admin' AND business_id IS NULL) OR (role = 'business' AND business_id IS NOT NULL))
);
CREATE INDEX idx_keys_business ON api_keys(business_id);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,                 -- SHA-256 of cookie value
  key_id      TEXT NOT NULL REFERENCES api_keys(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Public seal tokens (site keys). Not secret: they appear in client HTML.
-- Security comes from domain binding + live status + click-through verify page.
CREATE TABLE seal_tokens (
  id              TEXT PRIMARY KEY,             -- seal_xxx
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  allowed_domains TEXT NOT NULL,                -- JSON array of hostnames
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE INDEX idx_seals_business ON seal_tokens(business_id);

CREATE TABLE certifications (
  id                TEXT PRIMARY KEY,           -- cert_xxx
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  status            TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  issued_at         INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  review_window     INTEGER NOT NULL,           -- "last N reviews" checked live
  min_verified_ratio REAL NOT NULL,             -- e.g. 1.0 = all of last N verified
  min_reviews       INTEGER NOT NULL,
  issued_by         TEXT NOT NULL,
  notes             TEXT,
  status_reason     TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_certs_business ON certifications(business_id, issued_at DESC);

-- Review invitations tied to a real transaction reported by the business.
CREATE TABLE invitations (
  id            TEXT PRIMARY KEY,               -- inv_xxx
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  order_ref     TEXT NOT NULL,
  email_hash    TEXT NOT NULL,                  -- HMAC, kept for dedupe/fraud
  email         TEXT,                           -- plaintext only until used/expired (for delivery)
  customer_name TEXT,
  token_hash    TEXT NOT NULL UNIQUE,           -- SHA-256 of the link token
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  used_at       INTEGER,
  UNIQUE (business_id, order_ref)
);

CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,              -- rev_xxx
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  source         TEXT NOT NULL CHECK (source IN ('invite','google','yelp','facebook','csv','other')),
  external_id    TEXT,
  invitation_id  TEXT REFERENCES invitations(id),
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title          TEXT,
  body           TEXT NOT NULL,
  author_name    TEXT,
  reviewed_at    INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','held','approved','rejected')),
  verification   TEXT NOT NULL DEFAULT 'none' CHECK (verification IN ('none','transaction','audited')),
  fraud_score    INTEGER NOT NULL DEFAULT 0,
  fraud_flags    TEXT NOT NULL DEFAULT '[]',
  ip_hash        TEXT,
  ua_hash        TEXT,
  created_at     INTEGER NOT NULL,
  decided_by     TEXT,
  decided_at     INTEGER,
  decision_note  TEXT,
  UNIQUE (business_id, source, external_id)
);
CREATE INDEX idx_reviews_business_time ON reviews(business_id, reviewed_at DESC);
CREATE INDEX idx_reviews_status ON reviews(status, created_at);
CREATE INDEX idx_reviews_ip ON reviews(business_id, ip_hash);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,                      -- key id, 'system', 'public'
  action    TEXT NOT NULL,
  target    TEXT,
  details   TEXT,
  ip_hash   TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);

CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,                -- "<name>:<subject>:<window>"
  count        INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
