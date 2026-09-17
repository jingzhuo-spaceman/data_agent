import { MemoryClient } from 'mem0ai';
import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';
import { assertSafeText, immutableCopy } from './safe-payload.js';

function scopedUserId(actor) {
  return `tenant:${actor.tenantId}:actor:${actor.actorId}`;
}

function isoDate(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value ?? '');
  return Number.isNaN(timestamp) ? new Date().toISOString() : new Date(timestamp).toISOString();
}

function memoryFromResult(actor, expectedUserId, item) {
  if (!item || item.userId !== expectedUserId) return null;
  if (item.metadata?.tenantId !== actor.tenantId || item.metadata?.actorId !== actor.actorId) return null;
  const content = item.memory ?? item.data?.memory;
  if (typeof item.id !== 'string' || typeof content !== 'string' || content.trim() === '') return null;

  try {
    assertSafeText(content, 'memory content');
  } catch {
    return null;
  }

  return Object.freeze({
    id: item.id,
    tenantId: actor.tenantId,
    sourceId: `mem0:${item.id}`,
    content,
    expiresAt: item.expirationDate ?? null,
    createdAt: isoDate(item.createdAt),
  });
}

/**
 * Mem0 Platform adapter. Actor-derived entity and metadata fields are both
 * checked so a result from another tenant can never reach prompt assembly.
 */
export class Mem0MemoryStore {
  constructor({ apiKey, host = undefined, client = null }) {
    if (client) {
      this.client = client;
      return;
    }
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new ValidationError('MEM0_API_KEY is required when MEMORY_PROVIDER is mem0');
    }
    this.client = new MemoryClient({ apiKey, ...(host ? { host } : {}) });
  }

  async retrieve(context, query, { limit = 5 } = {}) {
    const actor = assertActorContext(context);
    assertSafeText(query, 'memory query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ValidationError('limit must be an integer from 1 to 20');
    }

    const userId = scopedUserId(actor);
    const response = await this.client.search(query, {
      filters: { user_id: userId },
      topK: limit,
    });
    const results = Array.isArray(response?.results) ? response.results : [];
    return results
      .map((item) => memoryFromResult(actor, userId, item))
      .filter(Boolean)
      .slice(0, limit)
      .map(immutableCopy);
  }

  async recordTurn(context, { sessionId, turnId, userMessage, assistantMessage }) {
    const actor = assertActorContext(context);
    for (const [name, value] of Object.entries({ sessionId, turnId })) {
      if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
    }
    assertSafeText(userMessage, 'user message');
    assertSafeText(assistantMessage, 'assistant message');

    return this.client.add([
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantMessage },
    ], {
      userId: scopedUserId(actor),
      runId: sessionId,
      metadata: {
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        turnId,
        source: 'agent-turn',
      },
    });
  }
}
