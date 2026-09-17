import { CapabilityError, ValidationError } from './errors.js';

function normalizedManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new ValidationError('plugin manifest is required');
  }
  for (const key of ['name', 'version', 'apiVersion']) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      throw new ValidationError(`plugin manifest ${key} is required`);
    }
  }
  for (const key of ['capabilities', 'requiredPermissions']) {
    if (!Array.isArray(manifest[key]) || manifest[key].some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new ValidationError(`plugin manifest ${key} must be an array of non-empty strings`);
    }
  }
  return {
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    capabilities: [...manifest.capabilities],
    requiredPermissions: [...manifest.requiredPermissions],
  };
}

export function manifestsMatch(left, right) {
  return JSON.stringify(normalizedManifest(left)) === JSON.stringify(normalizedManifest(right));
}

/**
 * Plugins are composition units, not a sandbox. Production plugins must be
 * reviewed/signed or execute out of process; this surface limits normal APIs.
 */
export class PluginRegistry {
  #tools = new Map();

  constructor({ allowUnverifiedPlugins = false } = {}) {
    this.allowUnverifiedPlugins = allowUnverifiedPlugins;
  }

  use(plugin, { expectedManifest = null } = {}) {
    if (!plugin || typeof plugin.register !== 'function' || !plugin.manifest) {
      throw new ValidationError('plugin with manifest and register() is required');
    }
    normalizedManifest(plugin.manifest);
    if (!this.allowUnverifiedPlugins && !expectedManifest) {
      throw new CapabilityError('Production plugin registration requires a verified profile manifest');
    }
    if (expectedManifest && !manifestsMatch(plugin.manifest, expectedManifest)) {
      throw new CapabilityError(`Plugin implementation does not match verified manifest: ${plugin.manifest.name}`);
    }
    const disposable = plugin.register(Object.freeze({
      registerTool: (definition) => this.registerTool(definition),
    }));
    return disposable;
  }

  registerTool({ name, validate, execute }) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ValidationError('tool name is required');
    }
    if (typeof validate !== 'function' || typeof execute !== 'function') {
      throw new ValidationError('tool validate() and execute() are required');
    }
    if (this.#tools.has(name)) {
      throw new ValidationError(`Tool is already registered: ${name}`);
    }
    this.#tools.set(name, Object.freeze({ name, validate, execute }));
  }

  require(name) {
    const tool = this.#tools.get(name);
    if (!tool) throw new ValidationError(`Unknown tool: ${name}`);
    return tool;
  }
}
