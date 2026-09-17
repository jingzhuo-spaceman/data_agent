import { randomUUID } from 'node:crypto';
import { assertActorContext } from './actor-context.js';
import { AuthorizationError, ValidationError } from './errors.js';
import { assertSafeEventPayload, immutableCopy } from './safe-payload.js';

/** Append-only, tenant-scoped event log. Replace with an event store in production. */
export class SessionEventLog {
  #sessions = new Map();

  createSession(context, sessionId = randomUUID()) {
    const actor = assertActorContext(context);
    if (this.#sessions.has(sessionId)) {
      throw new ValidationError('sessionId already exists');
    }

    this.#sessions.set(sessionId, {
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      events: [],
    });
    return sessionId;
  }

  append(context, { sessionId, turnId, type, payload = {} }) {
    const actor = assertActorContext(context);
    const session = this.#requireOwnedSession(actor, sessionId);
    if (typeof turnId !== 'string' || turnId.trim() === '') {
      throw new ValidationError('turnId must be a non-empty string');
    }
    if (typeof type !== 'string' || type.trim() === '') {
      throw new ValidationError('event type must be a non-empty string');
    }
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
    session.events.push(event);
    return immutableCopy(event);
  }

  list(context, sessionId) {
    const actor = assertActorContext(context);
    const session = this.#requireOwnedSession(actor, sessionId);
    return session.events.map(immutableCopy);
  }

  ownsSession(context, sessionId) {
    const actor = assertActorContext(context);
    const session = this.#sessions.get(sessionId);
    return Boolean(session && session.tenantId === actor.tenantId && session.actorId === actor.actorId);
  }

  listTenantSessions(context) {
    const actor = assertActorContext(context);
    return [...this.#sessions.entries()]
      .filter(([, session]) => session.tenantId === actor.tenantId)
      .map(([sessionId, session]) => Object.freeze({
        sessionId,
        events: session.events.map(immutableCopy),
      }));
  }

  clearTenantSessions(context) {
    const actor = assertActorContext(context);
    let count = 0;
    for (const [sessionId, session] of this.#sessions.entries()) {
      if (session.tenantId === actor.tenantId) {
        this.#sessions.delete(sessionId);
        count += 1;
      }
    }
    return count;
  }

  #requireOwnedSession(actor, sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session || session.tenantId !== actor.tenantId) {
      // Match resource behavior and do not disclose another tenant's session.
      throw new AuthorizationError();
    }
    return session;
  }
}
