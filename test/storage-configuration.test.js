import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationError, longTermMemoryProviderFromEnvironment } from '../src/index.js';

test('long-term memory configuration keeps PostgreSQL as the default', () => {
  assert.equal(longTermMemoryProviderFromEnvironment({}), 'postgres');
  assert.equal(longTermMemoryProviderFromEnvironment({ MEM0_API_KEY: 'key' }), 'mem0');
});

test('LONG_TERM_MEMORY_PROVIDER selects the memory layer and takes precedence over the legacy alias', () => {
  assert.equal(longTermMemoryProviderFromEnvironment({ LONG_TERM_MEMORY_PROVIDER: 'mem0' }), 'mem0');
  assert.equal(longTermMemoryProviderFromEnvironment({ MEMORY_PROVIDER: 'mem0' }), 'mem0');
  assert.equal(longTermMemoryProviderFromEnvironment({ LONG_TERM_MEMORY_PROVIDER: 'postgres', MEMORY_PROVIDER: 'mem0' }), 'postgres');
  assert.throws(() => longTermMemoryProviderFromEnvironment({ LONG_TERM_MEMORY_PROVIDER: 'redis' }), ValidationError);
});
