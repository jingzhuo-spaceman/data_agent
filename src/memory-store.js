import { randomUUID } from 'node:crypto';
import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';
import { assertSafeText, immutableCopy } from './safe-payload.js';

function tokenize(text) {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function score(queryTokens, content) {
  const contentTokens = tokenize(content);
  return [...queryTokens].filter((token) => contentTokens.has(token)).length;
}

/**
 * Tenant-bound long-term memory. A vector database adapter can replace the
 * scoring implementation, but its public API must retain this tenant boundary.
 */
export class TenantMemoryStore {
  #items = new Map();

  remember(context, { content, sourceId, expiresAt = null, id = randomUUID() }) {
    const actor = assertActorContext(context);
    assertSafeText(content, 'memory content');
    if (typeof sourceId !== 'string' || sourceId.trim() === '') {
      throw new ValidationError('sourceId must be a non-empty string');
    }
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
      throw new ValidationError('expiresAt must be an ISO timestamp or null');
    }
    const items = this.#forTenant(actor.tenantId);
    if (items.has(id)) throw new ValidationError('memory id already exists in this tenant');

    const item = Object.freeze({
      id,
      tenantId: actor.tenantId,
      content,
      sourceId,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    items.set(id, item);
    return immutableCopy(item);
  }

  retrieve(context, query, { limit = 5 } = {}) {
    const actor = assertActorContext(context);
    assertSafeText(query, 'memory query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ValidationError('limit must be an integer from 1 to 20');
    }
    const now = Date.now();
    const queryTokens = tokenize(query);
    return [...this.#forTenant(actor.tenantId).values()]
      .filter((item) => item.expiresAt === null || Date.parse(item.expiresAt) > now)
      .map((item) => ({ item, score: score(queryTokens, item.content) }))
      .filter(({ score: itemScore }) => itemScore > 0)
      .sort((left, right) => right.score - left.score || right.item.createdAt.localeCompare(left.item.createdAt))
      .slice(0, limit)
      .map(({ item }) => immutableCopy(item));
  }

  forget(context, memoryId) {
    const actor = assertActorContext(context);
    if (typeof memoryId !== 'string' || memoryId.trim() === '') {
      throw new ValidationError('memoryId must be a non-empty string');
    }
    return this.#forTenant(actor.tenantId).delete(memoryId);
  }

  list(context) {
    const actor = assertActorContext(context);
    return [...this.#forTenant(actor.tenantId).values()].map(immutableCopy);
  }

  clear(context) {
    const actor = assertActorContext(context);
    const items = this.#forTenant(actor.tenantId);
    const count = items.size;
    items.clear();
    return count;
  }

  #forTenant(tenantId) {
    if (!this.#items.has(tenantId)) this.#items.set(tenantId, new Map());
    return this.#items.get(tenantId);
  }
}
