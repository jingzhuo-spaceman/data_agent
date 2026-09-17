import { assertActorContext } from './actor-context.js';
import { AuthorizationError, ValidationError } from './errors.js';

function segment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new ValidationError(`${name} must be an object-key-safe identifier`);
  }
  return value;
}

/** Derives object keys from a grant; callers cannot choose an arbitrary prefix. */
export class TenantObjectStoragePolicy {
  constructor({ capabilityBroker }) {
    if (!capabilityBroker || typeof capabilityBroker.assertUsable !== 'function') {
      throw new ValidationError('capabilityBroker is required');
    }
    this.capabilityBroker = capabilityBroker;
  }

  writeTarget(context, { grant, tool, resourceType, resourceId, extension = 'json' }) {
    const actor = assertActorContext(context);
    this.capabilityBroker.assertUsable(actor, grant, { tool });
    const prefix = grant.allowedObjectPrefixes[0];
    const expectedPrefix = `tenants/${actor.tenantId}/`;
    if (!prefix || !prefix.startsWith(expectedPrefix)) throw new AuthorizationError();
    return Object.freeze({
      key: `${prefix}/${segment(resourceType, 'resourceType')}/${segment(resourceId, 'resourceId')}.${segment(extension, 'extension')}`,
      tenantId: actor.tenantId,
      expiresAt: grant.expiresAt,
    });
  }

  assertReadable(context, objectKey) {
    const actor = assertActorContext(context);
    if (typeof objectKey !== 'string' || objectKey.includes('..') || !objectKey.startsWith(`tenants/${actor.tenantId}/`)) {
      throw new AuthorizationError();
    }
    return objectKey;
  }
}
