import { assertActorContext } from './actor-context.js';
import { AuthorizationError, CapabilityError, ValidationError } from './errors.js';
import { immutableCopy } from './safe-payload.js';

const PLAINTEXT_SECRET_FIELD = /^(?:api[-_]?key|token|refresh[-_]?token|cookie|password|secret|credential)$/i;

function assertText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  return value;
}

function assertNoPlaintextSecret(input) {
  for (const key of Object.keys(input)) {
    if (PLAINTEXT_SECRET_FIELD.test(key)) {
      throw new ValidationError(`Connection metadata cannot contain plaintext secret field: ${key}`);
    }
  }
}

/**
 * Connection metadata store. The secretRef is opaque and must point to an
 * external KMS/Vault implementation; no plaintext credential enters this API.
 */
export class ConnectionCatalog {
  #connections = new Map();

  create(context, input) {
    const actor = assertActorContext(context);
    assertNoPlaintextSecret(input ?? {});
    const { id, provider, secretRef, allowedHosts = [], scopes = [], expiresAt = null } = input ?? {};
    assertText(id, 'connection id');
    assertText(provider, 'provider');
    assertText(secretRef, 'secretRef');
    if (!/^(?:vault|kms):\/\//.test(secretRef)) {
      throw new ValidationError('secretRef must use a vault:// or kms:// reference');
    }
    if (!Array.isArray(allowedHosts) || allowedHosts.some((host) => typeof host !== 'string' || host.trim() === '')) {
      throw new ValidationError('allowedHosts must be an array of hostnames');
    }
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope.trim() === '')) {
      throw new ValidationError('scopes must be an array of strings');
    }
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
      throw new ValidationError('expiresAt must be an ISO timestamp or null');
    }
    const tenantConnections = this.#forTenant(actor.tenantId);
    if (tenantConnections.has(id)) throw new ValidationError('connection id already exists in this tenant');
    const connection = Object.freeze({
      id,
      tenantId: actor.tenantId,
      provider,
      secretRef,
      allowedHosts: Object.freeze([...new Set(allowedHosts)]),
      scopes: Object.freeze([...new Set(scopes)]),
      expiresAt,
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    tenantConnections.set(id, connection);
    return immutableCopy(connection);
  }

  get(context, connectionId) {
    const actor = assertActorContext(context);
    assertText(connectionId, 'connection id');
    const connection = this.#forTenant(actor.tenantId).get(connectionId);
    return connection ? immutableCopy(connection) : null;
  }

  revoke(context, connectionId) {
    const actor = assertActorContext(context);
    const connection = this.get(actor, connectionId);
    if (!connection) throw new AuthorizationError();
    this.#forTenant(actor.tenantId).set(connectionId, Object.freeze({ ...connection, status: 'revoked', revokedAt: new Date().toISOString() }));
  }

  resolveForGrant(context, { capabilityBroker, grant, tool, connectionId }) {
    const actor = assertActorContext(context);
    capabilityBroker.assertUsable(actor, grant, { tool });
    if (grant.connectionId !== connectionId) throw new AuthorizationError();
    const connection = this.get(actor, connectionId);
    if (!connection) throw new AuthorizationError();
    if (connection.status !== 'active') throw new CapabilityError('Connection is not active');
    if (connection.expiresAt !== null && Date.parse(connection.expiresAt) <= Date.now()) {
      throw new CapabilityError('Connection has expired');
    }
    return connection;
  }

  #forTenant(tenantId) {
    if (!this.#connections.has(tenantId)) this.#connections.set(tenantId, new Map());
    return this.#connections.get(tenantId);
  }
}
