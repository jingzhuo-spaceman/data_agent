import { randomUUID } from 'node:crypto';
import { assertActorContext } from './actor-context.js';
import { AuthorizationError, ValidationError } from './errors.js';
import { assertSafeEventPayload, assertSafeText, immutableCopy } from './safe-payload.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError(`${name} must be a UUID`);
  }
  return value;
}

function memoryRow(row) {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    content: row.content,
    sourceId: row.source_id,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
}

function eventRow(row) {
  return Object.freeze({
    eventId: row.event_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    type: row.event_type,
    payload: row.payload,
    timestamp: row.occurred_at.toISOString(),
    schemaVersion: 1,
  });
}

/** Private tenant registry. It is used by trusted identity/bootstrap code only. */
export class TenantRegistry {
  constructor({ database }) {
    this.database = database;
  }

  async create({ id = randomUUID(), displayName }) {
    uuid(id, 'tenant id');
    assertSafeText(displayName, 'tenant displayName');
    const result = await this.database.pool.query(
      `INSERT INTO agent.tenants (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, display_name, status, created_at`,
      [id, displayName],
    );
    return Object.freeze({
      id: result.rows[0].id,
      displayName: result.rows[0].display_name,
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at.toISOString(),
    });
  }

  async exists(tenantId) {
    uuid(tenantId, 'tenant id');
    const result = await this.database.pool.query('SELECT 1 FROM agent.tenants WHERE id = $1 AND status = $2', [tenantId, 'active']);
    return result.rowCount === 1;
  }

  async list() {
    const result = await this.database.pool.query('SELECT id, display_name, status, created_at FROM agent.tenants ORDER BY created_at');
    return result.rows.map((row) => Object.freeze({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

/** PostgreSQL replacement for the in-memory SessionEventLog used by model turns. */
export class PostgresSessionEventLog {
  constructor({ database }) {
    this.database = database;
  }

  async createSession(context, sessionId = randomUUID()) {
    const actor = assertActorContext(context);
    uuid(sessionId, 'sessionId');
    await this.database.withTenant(actor, async (client) => {
      await client.query(
        'INSERT INTO agent.sessions (tenant_id, id, actor_id) VALUES ($1, $2, $3)',
        [actor.tenantId, sessionId, actor.actorId],
      );
    });
    return sessionId;
  }

  async ownsSession(context, sessionId) {
    const actor = assertActorContext(context);
    uuid(sessionId, 'sessionId');
    return this.database.withTenant(actor, async (client) => {
      const result = await client.query('SELECT 1 FROM agent.sessions WHERE tenant_id = $1 AND id = $2 AND actor_id = $3', [actor.tenantId, sessionId, actor.actorId]);
      return result.rowCount === 1;
    });
  }

  async append(context, { sessionId, turnId, type, payload = {} }) {
    const actor = assertActorContext(context);
    uuid(sessionId, 'sessionId');
    uuid(turnId, 'turnId');
    if (typeof type !== 'string' || type.trim() === '') throw new ValidationError('event type must be a non-empty string');
    assertSafeEventPayload(payload);
    const event = Object.freeze({
      eventId: randomUUID(),
      sessionId,
      turnId,
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      type,
      payload: immutableCopy(payload),
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
    });
    await this.database.withTenant(actor, async (client) => {
      const session = await client.query('SELECT 1 FROM agent.sessions WHERE tenant_id = $1 AND id = $2 AND actor_id = $3', [actor.tenantId, sessionId, actor.actorId]);
      if (session.rowCount === 0) throw new AuthorizationError();
      await client.query(
        `INSERT INTO agent.session_events
          (tenant_id, event_id, session_id, turn_id, actor_id, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [event.tenantId, event.eventId, event.sessionId, event.turnId, event.actorId, event.type, JSON.stringify(event.payload), event.timestamp],
      );
    });
    return immutableCopy(event);
  }

  async list(context, sessionId) {
    const actor = assertActorContext(context);
    uuid(sessionId, 'sessionId');
    return this.database.withTenant(actor, async (client) => {
      const session = await client.query('SELECT 1 FROM agent.sessions WHERE tenant_id = $1 AND id = $2 AND actor_id = $3', [actor.tenantId, sessionId, actor.actorId]);
      if (session.rowCount === 0) throw new AuthorizationError();
      const result = await client.query(
        `SELECT tenant_id, event_id, session_id, turn_id, actor_id, event_type, payload, occurred_at
           FROM agent.session_events WHERE tenant_id = $1 AND session_id = $2 ORDER BY occurred_at, event_id`,
        [actor.tenantId, sessionId],
      );
      return result.rows.map(eventRow);
    });
  }

  async listSessions(context) {
    const actor = assertActorContext(context);
    return this.database.withTenant(actor, async (client) => {
      const result = await client.query(
        `SELECT s.id, s.created_at, COALESCE(activity.last_activity, s.created_at) AS last_activity,
                activity.preview
           FROM agent.sessions AS s
           LEFT JOIN LATERAL (
             SELECT e.occurred_at AS last_activity, e.payload ->> 'content' AS preview
               FROM agent.session_events AS e
              WHERE e.tenant_id = s.tenant_id AND e.session_id = s.id
                AND e.event_type IN ('user.message', 'assistant.message')
              ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1
           ) AS activity ON true
          WHERE s.tenant_id = $1 AND s.actor_id = $2
          ORDER BY COALESCE(activity.last_activity, s.created_at) DESC, s.id DESC`,
        [actor.tenantId, actor.actorId],
      );
      return result.rows.map((row) => Object.freeze({
        sessionId: row.id,
        createdAt: row.created_at.toISOString(),
        lastActivity: row.last_activity.toISOString(),
        preview: row.preview ?? null,
      }));
    });
  }
}

/** PostgreSQL replacement for the in-memory tenant memory used by model turns. */
export class PostgresMemoryStore {
  constructor({ database }) {
    this.database = database;
  }

  async remember(context, { content, sourceId, expiresAt = null, id = randomUUID() }) {
    const actor = assertActorContext(context);
    uuid(id, 'memory id');
    uuid(sourceId, 'memory sourceId');
    assertSafeText(content, 'memory content');
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) throw new ValidationError('expiresAt must be an ISO timestamp or null');
    return this.database.withTenant(actor, async (client) => {
      const result = await client.query(
        `INSERT INTO agent.memory_items (tenant_id, id, source_id, content, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, tenant_id, source_id, content, expires_at, created_at`,
        [actor.tenantId, id, sourceId, content, expiresAt],
      );
      return memoryRow(result.rows[0]);
    });
  }

  async retrieve(context, query, { limit = 5 } = {}) {
    const actor = assertActorContext(context);
    assertSafeText(query, 'memory query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ValidationError('limit must be an integer from 1 to 20');
    return this.database.withTenant(actor, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, source_id, content, expires_at, created_at
           FROM agent.memory_items
          WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at DESC LIMIT $2`,
        [actor.tenantId, limit],
      );
      return result.rows.map(memoryRow);
    });
  }
}
