import { ValidationError } from './errors.js';

const PROVIDERS = new Set(['mem0', 'postgres']);

/**
 * PostgreSQL always owns sessions and audit events. This setting selects only
 * the store used to retrieve and record long-term model memory.
 */
export function longTermMemoryProviderFromEnvironment(environment = process.env) {
  const configured = environment.LONG_TERM_MEMORY_PROVIDER
    ?? environment.MEMORY_PROVIDER
    ?? (environment.MEM0_API_KEY ? 'mem0' : 'postgres');
  const provider = configured.toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new ValidationError('LONG_TERM_MEMORY_PROVIDER must be either mem0 or postgres');
  }
  return provider;
}
