import { ValidationError } from './errors.js';

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

/**
 * This constructor represents work performed after authentication. Public API
 * handlers should create it from verified identity claims, never request data.
 */
export function createActorContext({ actorId, tenantId, scopes = [] }) {
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
    throw new ValidationError('scopes must be an array of strings');
  }

  return Object.freeze({
    actorId: nonEmptyString(actorId, 'actorId'),
    tenantId: nonEmptyString(tenantId, 'tenantId'),
    scopes: Object.freeze([...new Set(scopes)]),
  });
}

export function assertActorContext(context) {
  if (!context || typeof context !== 'object') {
    throw new ValidationError('A trusted ActorContext is required');
  }
  return createActorContext(context);
}
