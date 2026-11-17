-- Base do post-nox: tenants (SaaS que chamam a API), canais conectados, mídia, posts e webhooks de saída.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  api_key_hash       TEXT NOT NULL UNIQUE,          -- sha256 hex da chave (a chave é aleatória de 32 bytes)
  webhook_url        TEXT,
  webhook_secret_enc TEXT NOT NULL,                 -- secretBox
  oauth_return_url   TEXT,                          -- para onde o callback do OAuth manda a pessoa se o connect não disser
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- state do OAuth: vale 1 hora, uso único.
CREATE TABLE oauth_states (
  state          TEXT PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  network        TEXT NOT NULL,
  code_verifier  TEXT,
  return_url     TEXT,
  ref            TEXT,                              -- devolvido ao tenant no redirect e no webhook (ex.: id da persona)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  network          TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  name             TEXT NOT NULL,
  username         TEXT,
  picture          TEXT,
  credentials_enc  TEXT NOT NULL,                   -- secretBox(JSON { accessToken, refreshToken?, ... })
  expires_at       TIMESTAMPTZ,                     -- vencimento do access token (NULL = não vence / sem refresh)
  meta             JSONB NOT NULL DEFAULT '{}',
  ref              TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'disabled')),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, network, external_id)
);
CREATE INDEX channels_refresh_idx ON channels (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE TABLE media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_ref     TEXT,                            -- id do lado do tenant; idempotência do POST /posts
  text             TEXT NOT NULL DEFAULT '',
  media            JSONB NOT NULL DEFAULT '[]',     -- [{ url, type: image|video, thumbnail?, alt? }]
  settings         JSONB NOT NULL DEFAULT '{}',     -- opções por rede
  scheduled_at     TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'publishing', 'processing', 'published', 'failed', 'cancelled')),
  next_check_at    TIMESTAMPTZ,                     -- quando checar de novo um post em processing
  checks           INT NOT NULL DEFAULT 0,
  pending_data     JSONB,                           -- estado opaco do provider enquanto processa
  started_at       TIMESTAMPTZ,
  remote_id        TEXT,
  remote_url       TEXT,
  error            TEXT,
  published_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX posts_external_ref_uq ON posts (tenant_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX posts_due_idx ON posts (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX posts_processing_idx ON posts (next_check_at) WHERE status = 'processing';
CREATE INDEX posts_tenant_idx ON posts (tenant_id, created_at DESC);

-- Webhooks para o tenant (outbox, mesmo padrão do Nox).
CREATE TABLE outbound_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code  INT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ
);
CREATE INDEX outbound_events_due_idx ON outbound_events (next_attempt_at) WHERE status = 'pending';
