import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';
import { immutableCopy } from './safe-payload.js';

function assertResourceId(resourceId) {
  if (typeof resourceId !== 'string' || resourceId.trim() === '') {
    throw new ValidationError('resourceId must be a non-empty string');
  }
}

/**
 * A repository-shaped in-memory adapter. It deliberately exposes no global
 * lookup: callers must bring a trusted tenant context to every operation.
 */
export class TenantStore {
  #resources = new Map();

  create(context, { id, type, data }) {
    const actor = assertActorContext(context);
    assertResourceId(id);
    if (typeof type !== 'string' || type.trim() === '') {
      throw new ValidationError('type must be a non-empty string');
    }

    const resources = this.#forTenant(actor.tenantId);
    if (resources.has(id)) {
      throw new ValidationError('resourceId already exists in this tenant');
    }

    const resource = Object.freeze({
      id,
      tenantId: actor.tenantId,
      type,
      data: immutableCopy(data),
      createdAt: new Date().toISOString(),
    });
    resources.set(id, resource);
    return immutableCopy(resource);
  }

  get(context, resourceId) {
    const actor = assertActorContext(context);
    assertResourceId(resourceId);
    const resource = this.#forTenant(actor.tenantId).get(resourceId);
    return resource ? immutableCopy(resource) : null;
  }

  owns(context, resourceId) {
    return this.get(context, resourceId) !== null;
  }

  list(context) {
    const actor = assertActorContext(context);
    return [...this.#forTenant(actor.tenantId).values()].map(immutableCopy);
  }

  clear(context) {
    const actor = assertActorContext(context);
    const resources = this.#forTenant(actor.tenantId);
    const count = resources.size;
    resources.clear();
    return count;
  }

  #forTenant(tenantId) {
    if (!this.#resources.has(tenantId)) {
      this.#resources.set(tenantId, new Map());
    }
    return this.#resources.get(tenantId);
  }
}
