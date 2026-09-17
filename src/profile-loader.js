import { verify } from 'node:crypto';
import { IntegrityError, ValidationError } from './errors.js';

function normalizePluginDescriptor(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new ValidationError('plugin descriptor is required');
  const { name, version, apiVersion, capabilities, requiredPermissions } = manifest;
  if ([name, version, apiVersion].some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new ValidationError('plugin descriptor name, version, and apiVersion are required');
  }
  if (![capabilities, requiredPermissions].every(Array.isArray)) {
    throw new ValidationError('plugin descriptor capabilities and requiredPermissions must be arrays');
  }
  return {
    name,
    version,
    apiVersion,
    capabilities: [...capabilities],
    requiredPermissions: [...requiredPermissions],
  };
}

/**
 * Stable payload format for a detached Ed25519 signature. Plugin order stays
 * significant because registration order can affect prompt/tool composition.
 */
export function canonicalProfilePayload(profile) {
  if (!profile || typeof profile !== 'object') throw new ValidationError('profile is required');
  if (typeof profile.name !== 'string' || profile.name.trim() === '') throw new ValidationError('profile name is required');
  if (typeof profile.version !== 'string' || profile.version.trim() === '') throw new ValidationError('profile version is required');
  if (!Array.isArray(profile.plugins) || profile.plugins.length === 0) throw new ValidationError('profile plugins are required');

  return Buffer.from(JSON.stringify({
    name: profile.name,
    version: profile.version,
    plugins: profile.plugins.map(normalizePluginDescriptor),
  }));
}

export class SignedProfileLoader {
  constructor({ trustedSigners }) {
    if (!(trustedSigners instanceof Map) || trustedSigners.size === 0) {
      throw new ValidationError('trustedSigners must be a non-empty Map');
    }
    this.trustedSigners = trustedSigners;
  }

  verify(profile) {
    const signer = this.trustedSigners.get(profile?.signerId);
    if (!signer) throw new IntegrityError('Profile signer is not trusted');
    if (typeof profile.signature !== 'string' || profile.signature.trim() === '') {
      throw new IntegrityError('Profile signature is required');
    }
    const signature = Buffer.from(profile.signature, 'base64');
    if (signature.length === 0 || !verify(null, canonicalProfilePayload(profile), signer, signature)) {
      throw new IntegrityError('Profile signature verification failed');
    }
    return Object.freeze({
      name: profile.name,
      version: profile.version,
      signerId: profile.signerId,
      plugins: Object.freeze(profile.plugins.map((plugin) => Object.freeze(normalizePluginDescriptor(plugin)))),
    });
  }

  load(profile, implementations, registry) {
    const verified = this.verify(profile);
    if (!Array.isArray(implementations) || !registry || typeof registry.use !== 'function') {
      throw new ValidationError('implementations and plugin registry are required');
    }
    const byIdentity = new Map(implementations.map((plugin) => [`${plugin.manifest.name}@${plugin.manifest.version}`, plugin]));
    if (byIdentity.size !== implementations.length) throw new IntegrityError('Duplicate plugin implementations are not allowed');
    if (byIdentity.size !== verified.plugins.length) throw new IntegrityError('Profile and implementation counts differ');

    const disposables = verified.plugins.map((descriptor) => {
      const implementation = byIdentity.get(`${descriptor.name}@${descriptor.version}`);
      if (!implementation) throw new IntegrityError(`Missing plugin implementation: ${descriptor.name}@${descriptor.version}`);
      return registry.use(implementation, { expectedManifest: descriptor });
    });
    return Object.freeze({
      profile: verified,
      dispose: () => disposables.reverse().forEach((disposable) => disposable?.dispose?.()),
    });
  }
}
