import { randomUUID } from 'node:crypto';
import { assertActorContext } from './actor-context.js';
import { AuthorizationError, CapabilityError, ValidationError } from './errors.js';

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${name} must be a non-negative integer`);
  }
}

/**
 * The broker is the only component that can mint a grant. A tool receives a
 * grant after ownership checks, not a reusable connection to tenant storage.
 */
export class CapabilityBroker {
  #grants = new Map();

  constructor({ resourceStore, allowedTools, grantTtlMs = 60_000 }) {
    if (!resourceStore || typeof resourceStore.owns !== 'function') {
      throw new ValidationError('resourceStore with owns() is required');
    }
    if (!allowedTools || !(allowedTools instanceof Set)) {
      throw new ValidationError('allowedTools must be a Set');
    }
    if (!Number.isInteger(grantTtlMs) || grantTtlMs <= 0) {
      throw new ValidationError('grantTtlMs must be a positive integer');
    }
    this.resourceStore = resourceStore;
    this.allowedTools = allowedTools;
    this.grantTtlMs = grantTtlMs;
  }

  authorize(context, { sessionId, turnId, tool, resourceIds = [], connectionId = null, maxNetworkRequests = 0 }) {
    const actor = assertActorContext(context);
    if (!this.allowedTools.has(tool)) {
      throw new CapabilityError(`Tool is not enabled for this profile: ${tool}`);
    }
    if (!Array.isArray(resourceIds) || resourceIds.some((id) => typeof id !== 'string')) {
      throw new ValidationError('resourceIds must be an array of strings');
    }
    assertPositiveInteger(maxNetworkRequests, 'maxNetworkRequests');
    if (connectionId !== null && (typeof connectionId !== 'string' || connectionId.trim() === '')) {
      throw new ValidationError('connectionId must be a non-empty string or null');
    }

    for (const resourceId of resourceIds) {
      if (!this.resourceStore.owns(actor, resourceId)) {
        throw new AuthorizationError();
      }
    }

    const now = Date.now();
    const grant = Object.freeze({
      grantId: randomUUID(),
      tenantId: actor.tenantId,
      sessionId,
      turnId,
      tool,
      allowedResourceIds: Object.freeze([...new Set(resourceIds)]),
      allowedObjectPrefixes: Object.freeze([`tenants/${actor.tenantId}/sessions/${sessionId}/turns/${turnId}`]),
      connectionId,
      maxNetworkRequests,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.grantTtlMs).toISOString(),
    });
    this.#grants.set(grant.grantId, { grant, revoked: false });
    return grant;
  }

  assertUsable(context, grant, { tool, resourceIds = [], networkRequests = 0 }) {
    const actor = assertActorContext(context);
    const stored = grant && this.#grants.get(grant.grantId);
    if (!stored || stored.grant !== grant || stored.revoked) {
      throw new CapabilityError('Capability grant is invalid or revoked');
    }
    if (stored.grant.tenantId !== actor.tenantId || stored.grant.tool !== tool) {
      throw new AuthorizationError();
    }
    if (Date.parse(stored.grant.expiresAt) <= Date.now()) {
      throw new CapabilityError('Capability grant has expired');
    }
    assertPositiveInteger(networkRequests, 'networkRequests');
    if (networkRequests > stored.grant.maxNetworkRequests) {
      throw new CapabilityError('Capability grant network budget exceeded');
    }
    if (resourceIds.some((id) => !stored.grant.allowedResourceIds.includes(id))) {
      throw new AuthorizationError();
    }
    return stored.grant;
  }

  revoke(grantId) {
    const stored = this.#grants.get(grantId);
    if (stored) stored.revoked = true;
  }
}
