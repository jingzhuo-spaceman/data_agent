CREATE TABLE agent.tenants (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE TABLE agent.sessions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES agent.tenants (id)
);

ALTER TABLE agent.datasets ADD CONSTRAINT datasets_tenant_fk FOREIGN KEY (tenant_id) REFERENCES agent.tenants (id);
ALTER TABLE agent.connections ADD CONSTRAINT connections_tenant_fk FOREIGN KEY (tenant_id) REFERENCES agent.tenants (id);
ALTER TABLE agent.memory_items ADD CONSTRAINT memory_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES agent.tenants (id);
ALTER TABLE agent.session_events ADD COLUMN actor_id text NOT NULL DEFAULT 'unknown';
ALTER TABLE agent.session_events ADD CONSTRAINT session_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES agent.tenants (id);
ALTER TABLE agent.session_events ADD CONSTRAINT session_events_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES agent.sessions (tenant_id, id);

CREATE INDEX sessions_by_tenant_actor ON agent.sessions (tenant_id, actor_id, created_at DESC);

ALTER TABLE agent.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant_scope ON agent.sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
