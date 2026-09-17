-- PostgreSQL 16+ tenant isolation baseline.
-- Application code must run every private-data transaction with:
--   SET LOCAL app.tenant_id = '<verified tenant UUID>';
-- The runtime role must not own these tables or hold BYPASSRLS.

CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE agent.datasets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  classification text NOT NULL DEFAULT 'PRIVATE',
  object_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (object_key LIKE 'tenants/' || tenant_id::text || '/%')
);

CREATE TABLE agent.connections (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  provider text NOT NULL,
  secret_ref text NOT NULL,
  allowed_hosts text[] NOT NULL DEFAULT '{}',
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (secret_ref ~ '^(vault|kms)://'),
  CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE TABLE agent.memory_items (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  content text NOT NULL,
  embedding_ref text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE agent.session_events (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX datasets_by_tenant_created_at ON agent.datasets (tenant_id, created_at DESC);
CREATE INDEX memory_items_by_tenant_created_at ON agent.memory_items (tenant_id, created_at DESC);
CREATE INDEX session_events_by_tenant_session ON agent.session_events (tenant_id, session_id, occurred_at);

ALTER TABLE agent.datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE agent.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE agent.session_events FORCE ROW LEVEL SECURITY;

CREATE POLICY datasets_tenant_scope ON agent.datasets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY connections_tenant_scope ON agent.connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY memory_items_tenant_scope ON agent.memory_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY session_events_tenant_scope ON agent.session_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON SCHEMA agent FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA agent FROM PUBLIC;
