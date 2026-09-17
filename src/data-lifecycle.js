import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';

const ERASE_CONFIRMATION = 'ERASE_TENANT_DATA';

/**
 * Product-level privacy lifecycle coordination. Production adapters must add
 * asynchronous backup expiration and legal-retention handling around this API.
 */
export class TenantDataLifecycle {
  constructor({ resourceStore, memoryStore, eventLog }) {
    if (!resourceStore || !memoryStore || !eventLog) {
      throw new ValidationError('resourceStore, memoryStore, and eventLog are required');
    }
    this.resourceStore = resourceStore;
    this.memoryStore = memoryStore;
    this.eventLog = eventLog;
  }

  export(context) {
    const actor = assertActorContext(context);
    return Object.freeze({
      tenantId: actor.tenantId,
      generatedAt: new Date().toISOString(),
      resources: Object.freeze(this.resourceStore.list(actor)),
      memories: Object.freeze(this.memoryStore.list(actor)),
      sessions: Object.freeze(this.eventLog.listTenantSessions(actor)),
    });
  }

  erase(context, { confirmation }) {
    const actor = assertActorContext(context);
    if (confirmation !== ERASE_CONFIRMATION) {
      throw new ValidationError('Deletion requires explicit ERASE_TENANT_DATA confirmation');
    }
    return Object.freeze({
      resourcesDeleted: this.resourceStore.clear(actor),
      memoriesDeleted: this.memoryStore.clear(actor),
      sessionsDeleted: this.eventLog.clearTenantSessions(actor),
    });
  }
}
