import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  AgentHarness,
  AuthorizationError,
  CapabilityBroker,
  CapabilityError,
  IntegrityError,
  ConnectionCatalog,
  LocalAnalysisWorker,
  Mem0MemoryStore,
  ModelAdapter,
  OpenAICompatibleModelAdapter,
  PluginRegistry,
  PromptAssembler,
  SessionReplay,
  SessionEventLog,
  SignedProfileLoader,
  TenantMemoryStore,
  TenantDataLifecycle,
  TenantObjectStoragePolicy,
  TenantStore,
  ValidationError,
  createActorContext,
  dataAnalysisPlugin,
  dataCatalogPlugin,
  canonicalProfilePayload,
} from '../src/index.js';

function makeSystem() {
  const store = new TenantStore();
  const registry = new PluginRegistry({ allowUnverifiedPlugins: true });
  registry.use(dataCatalogPlugin);
  registry.use(dataAnalysisPlugin);
  const broker = new CapabilityBroker({
    resourceStore: store,
    allowedTools: new Set(['dataset.summary', 'dataset.aggregate']),
  });
  const eventLog = new SessionEventLog();
  const memoryStore = new TenantMemoryStore();
  const promptAssembler = new PromptAssembler({ systemInstructions: 'Answer only from the current tenant context.' });
  const modelAdapter = new ModelAdapter({
    name: 'test-model',
    respond: ({ messages }) => ({ message: `Processed ${messages.at(-1).content}` }),
  });
  const worker = new LocalAnalysisWorker({ capabilityBroker: broker, resourceStore: store });
  return {
    store,
    eventLog,
    memoryStore,
    harness: new AgentHarness({
      eventLog,
      capabilityBroker: broker,
      pluginRegistry: registry,
      resourceStore: store,
      memoryStore,
      promptAssembler,
      modelAdapter,
      worker,
    }),
  };
}

function seed() {
  const system = makeSystem();
  const alice = createActorContext({ actorId: 'alice', tenantId: 'tenant-alice', scopes: ['agent:run'] });
  const bob = createActorContext({ actorId: 'bob', tenantId: 'tenant-bob', scopes: ['agent:run'] });
  system.store.create(alice, {
    id: 'dataset-alice',
    type: 'dataset',
    data: { rows: [{ city: 'Shanghai', revenue: 42 }, { city: 'Beijing', revenue: 7 }] },
  });
  return { ...system, alice, bob };
}

test('an authorized tenant can execute a data-catalog turn and receive durable events', () => {
  const { harness, eventLog, alice } = seed();
  const sessionId = harness.createSession(alice);

  const response = harness.runToolTurn(alice, {
    sessionId,
    toolName: 'dataset.summary',
    input: { datasetId: 'dataset-alice' },
    resourceIds: ['dataset-alice'],
  });

  assert.deepEqual(response.result, {
    datasetId: 'dataset-alice',
    fieldNames: ['city', 'revenue'],
    rowCount: 2,
    createdAt: response.result.createdAt,
  });
  const events = eventLog.list(alice, sessionId);
  assert.deepEqual(events.map((event) => event.type), [
    'turn.started', 'step.started', 'tool.call.proposed', 'tool.authorized',
    'tool.result', 'step.ended', 'turn.ended',
  ]);
  assert.ok(events.every((event) => event.tenantId === 'tenant-alice'));
});

test('a tenant cannot execute a tool against another tenant resource, even with its identifier', () => {
  const { harness, eventLog, alice, bob } = seed();
  const sessionId = harness.createSession(bob);

  assert.throws(() => harness.runToolTurn(bob, {
    sessionId,
    toolName: 'dataset.summary',
    input: { datasetId: 'dataset-alice' },
    resourceIds: ['dataset-alice'],
  }), AuthorizationError);
  assert.deepEqual(eventLog.list(bob, sessionId).map((event) => event.type), [
    'turn.started', 'step.started', 'tool.call.proposed', 'tool.denied', 'step.ended', 'turn.ended',
  ]);
  assert.throws(() => eventLog.list(alice, sessionId), AuthorizationError);
});

test('a session cannot be read across tenants', () => {
  const { harness, eventLog, alice, bob } = seed();
  const aliceSession = harness.createSession(alice);

  assert.throws(() => eventLog.list(bob, aliceSession), AuthorizationError);
});

test('a capability cannot exceed its authorized resource set', () => {
  const { harness, alice } = seed();
  const sessionId = harness.createSession(alice);

  assert.throws(() => harness.runToolTurn(alice, {
    sessionId,
    toolName: 'dataset.summary',
    input: { datasetId: 'dataset-alice' },
    resourceIds: [],
  }), AuthorizationError);
});

test('event payloads reject sensitive fields instead of persisting them', () => {
  const { eventLog, alice } = seed();
  const sessionId = eventLog.createSession(alice);

  assert.throws(() => eventLog.append(alice, {
    sessionId,
    turnId: 'turn-1',
    type: 'tool.result',
    payload: { apiKey: 'not-allowed' },
  }), ValidationError);
  assert.deepEqual(eventLog.list(alice, sessionId), []);
});

test('memory retrieval is tenant-scoped before prompt composition and model execution', async () => {
  const { harness, memoryStore, eventLog, alice, bob } = seed();
  memoryStore.remember(alice, { id: 'alice-memory', sourceId: 'pref-1', content: 'Alice prefers Shanghai revenue reports.' });
  memoryStore.remember(bob, { id: 'bob-memory', sourceId: 'pref-2', content: 'Bob prefers Beijing retention reports.' });
  const sessionId = harness.createSession(alice);

  const response = await harness.runModelTurn(alice, { sessionId, userMessage: 'Show the Shanghai report.' });

  assert.deepEqual(response.memoryIds, ['alice-memory']);
  assert.match(response.message, /Show the Shanghai report/);
  const events = eventLog.list(alice, sessionId);
  assert.deepEqual(events.find((event) => event.type === 'memory.retrieved').payload.memoryIds, ['alice-memory']);
  assert.equal(JSON.stringify(events).includes('bob-memory'), false);
});

test('an OpenAI-compatible adapter sends the composed messages to chat completions', async () => {
  let capturedRequest;
  const adapter = new OpenAICompatibleModelAdapter({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.example.test/v1',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      capturedRequest = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Provider response' } }] }) };
    },
  });

  const response = await adapter.complete({ messages: [{ role: 'user', content: 'Analyze revenue.' }] });

  assert.equal(response.message, 'Provider response');
  assert.equal(capturedRequest.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(capturedRequest.options.headers.authorization, 'Bearer test-api-key');
  assert.deepEqual(JSON.parse(capturedRequest.options.body), {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Analyze revenue.' }],
    stream: false,
  });
});

test('an aggregate tool executes through the worker with a tenant-scoped object prefix', () => {
  const { harness, alice } = seed();
  const sessionId = harness.createSession(alice);

  const response = harness.runToolTurn(alice, {
    sessionId,
    toolName: 'dataset.aggregate',
    input: { datasetId: 'dataset-alice', operation: 'sum', field: 'revenue' },
    resourceIds: ['dataset-alice'],
  });

  assert.equal(response.result.value, 49);
  assert.match(response.result.objectPrefix, /^tenants\/tenant-alice\/sessions\//);
  assert.equal(response.result.objectPrefix.includes('tenant-bob'), false);
});

test('obvious credential content is rejected before it can enter tenant memory', () => {
  const { memoryStore, alice } = seed();

  assert.throws(() => memoryStore.remember(alice, {
    sourceId: 'chat-1',
    content: 'api key: sk-12345678901234567890',
  }), ValidationError);
});

test('Mem0 memory scopes reads and writes to the actor-derived tenant identity', async () => {
  const calls = { adds: [], searches: [] };
  const client = {
    async add(messages, options) {
      calls.adds.push({ messages, options });
      return [];
    },
    async search(query, options) {
      calls.searches.push({ query, options });
      return {
        results: [
          {
            id: 'alice-memory',
            memory: 'Alice prefers Shanghai revenue reports.',
            userId: options.filters.user_id,
            metadata: { tenantId: 'tenant-alice', actorId: 'alice' },
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'mismatched-memory',
            memory: 'Must not be used.',
            userId: options.filters.user_id,
            metadata: { tenantId: 'tenant-bob', actorId: 'bob' },
          },
        ],
      };
    },
  };
  const store = new Mem0MemoryStore({ client });
  const alice = createActorContext({ actorId: 'alice', tenantId: 'tenant-alice', scopes: ['agent:run'] });

  await store.recordTurn(alice, {
    sessionId: 'session-a',
    turnId: 'turn-a',
    userMessage: 'Please remember I prefer Shanghai reports.',
    assistantMessage: 'I will remember that preference.',
  });
  const memories = await store.retrieve(alice, 'Which reports do I prefer?');

  assert.deepEqual(memories.map((memory) => memory.id), ['alice-memory']);
  assert.equal(calls.adds[0].options.userId, 'tenant:tenant-alice:actor:alice');
  assert.deepEqual(calls.adds[0].options.metadata, {
    tenantId: 'tenant-alice', actorId: 'alice', turnId: 'turn-a', source: 'agent-turn',
  });
  assert.deepEqual(calls.searches[0].options.filters, { user_id: 'tenant:tenant-alice:actor:alice' });
});

test('a model turn records the completed exchange when the memory adapter supports Mem0 writes', async () => {
  const { harness, eventLog, alice } = seed();
  const recorded = [];
  harness.memoryStore = {
    async retrieve() { return []; },
    async recordTurn(actor, turn) { recorded.push({ actor, turn }); },
  };
  const sessionId = harness.createSession(alice);

  await harness.runModelTurn(alice, { sessionId, userMessage: 'Remember that I prefer concise reports.' });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor.tenantId, 'tenant-alice');
  assert.equal(recorded[0].turn.sessionId, sessionId);
  assert.equal(recorded[0].turn.userMessage, 'Remember that I prefer concise reports.');
  assert.match(recorded[0].turn.assistantMessage, /Remember that I prefer concise reports/);
  assert.equal(eventLog.list(alice, sessionId).some((event) => event.type === 'memory.recorded'), true);
});

function signProfile(profile, privateKey) {
  return {
    ...profile,
    signerId: 'release-key-1',
    signature: sign(null, canonicalProfilePayload(profile), privateKey).toString('base64'),
  };
}

test('a production registry accepts only plugins described by a signed profile', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const profile = signProfile({
    name: 'data-readonly',
    version: '1.0.0',
    plugins: [dataCatalogPlugin.manifest],
  }, privateKey);
  const registry = new PluginRegistry();
  const loader = new SignedProfileLoader({ trustedSigners: new Map([['release-key-1', publicKey]]) });

  const loaded = loader.load(profile, [dataCatalogPlugin], registry);

  assert.equal(loaded.profile.name, 'data-readonly');
  assert.equal(registry.require('dataset.summary').name, 'dataset.summary');
  assert.throws(() => registry.use(dataAnalysisPlugin), CapabilityError);
  loaded.dispose();
});

test('a profile signature cannot be reused after its capability list changes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signedProfile = signProfile({
    name: 'data-readonly',
    version: '1.0.0',
    plugins: [dataCatalogPlugin.manifest],
  }, privateKey);
  const tamperedProfile = {
    ...signedProfile,
    plugins: [{ ...dataCatalogPlugin.manifest, capabilities: ['dataset.summary', 'dataset.aggregate'] }],
  };
  const loader = new SignedProfileLoader({ trustedSigners: new Map([['release-key-1', publicKey]]) });

  assert.throws(() => loader.verify(tamperedProfile), IntegrityError);
});

test('session replay reconstructs completed turn state without re-executing a tool', () => {
  const { harness, eventLog, alice } = seed();
  const sessionId = harness.createSession(alice);
  harness.runToolTurn(alice, {
    sessionId,
    toolName: 'dataset.summary',
    input: { datasetId: 'dataset-alice' },
    resourceIds: ['dataset-alice'],
  });
  const replay = new SessionReplay({ eventLog }).replay(alice, sessionId);

  assert.equal(replay.length, 1);
  assert.equal(replay[0].status, 'completed');
  assert.deepEqual(replay[0].steps.map((step) => step.status), ['completed']);
  assert.equal(replay[0].timeline.filter((entry) => entry.type === 'tool.result').length, 1);
});

test('a tenant can export and erase its own state without affecting another tenant', () => {
  const { harness, store, memoryStore, eventLog, alice, bob } = seed();
  store.create(bob, { id: 'dataset-bob', type: 'dataset', data: { rows: [{ city: 'Beijing' }] } });
  memoryStore.remember(alice, { id: 'memory-alice', sourceId: 'pref-1', content: 'Alice prefers weekly summaries.' });
  const aliceSession = harness.createSession(alice);
  harness.runToolTurn(alice, {
    sessionId: aliceSession,
    toolName: 'dataset.summary',
    input: { datasetId: 'dataset-alice' },
    resourceIds: ['dataset-alice'],
  });
  const lifecycle = new TenantDataLifecycle({ resourceStore: store, memoryStore, eventLog });

  const exported = lifecycle.export(alice);
  assert.deepEqual(exported.resources.map((resource) => resource.id), ['dataset-alice']);
  assert.deepEqual(exported.memories.map((memory) => memory.id), ['memory-alice']);
  assert.equal(exported.sessions.length, 1);
  assert.throws(() => lifecycle.erase(alice, { confirmation: 'incorrect' }), ValidationError);
  assert.deepEqual(lifecycle.erase(alice, { confirmation: 'ERASE_TENANT_DATA' }), {
    resourcesDeleted: 1,
    memoriesDeleted: 1,
    sessionsDeleted: 1,
  });
  assert.equal(store.get(alice, 'dataset-alice'), null);
  assert.equal(store.get(bob, 'dataset-bob').id, 'dataset-bob');
});

test('connection metadata stores only a Secret reference and remains tenant-bound', () => {
  const { alice, bob } = seed();
  const connections = new ConnectionCatalog();
  const connection = connections.create(alice, {
    id: 'social-alice',
    provider: 'example-social',
    secretRef: 'vault://tenant-alice/connections/social-alice',
    allowedHosts: ['api.example.test'],
    scopes: ['posts.read'],
  });

  assert.equal(connection.secretRef, 'vault://tenant-alice/connections/social-alice');
  assert.equal(connections.get(bob, 'social-alice'), null);
  assert.throws(() => connections.create(alice, {
    id: 'invalid-connection',
    provider: 'example-social',
    secretRef: 'vault://tenant-alice/connections/invalid',
    token: 'plaintext-not-allowed',
  }), ValidationError);
});

test('a connection grant and object target are bound to the current tenant and turn', () => {
  const { store, alice, bob } = seed();
  const broker = new CapabilityBroker({ resourceStore: store, allowedTools: new Set(['dataset.summary']) });
  const connections = new ConnectionCatalog();
  connections.create(alice, {
    id: 'source-alice',
    provider: 'example-source',
    secretRef: 'kms://tenant-alice/connection/source-alice',
  });
  const grant = broker.authorize(alice, {
    sessionId: 'session-a',
    turnId: 'turn-a',
    tool: 'dataset.summary',
    resourceIds: ['dataset-alice'],
    connectionId: 'source-alice',
  });
  const resolved = connections.resolveForGrant(alice, {
    capabilityBroker: broker,
    grant,
    tool: 'dataset.summary',
    connectionId: 'source-alice',
  });
  const policy = new TenantObjectStoragePolicy({ capabilityBroker: broker });
  const target = policy.writeTarget(alice, {
    grant,
    tool: 'dataset.summary',
    resourceType: 'exports',
    resourceId: 'report-1',
  });

  assert.equal(resolved.provider, 'example-source');
  assert.equal(target.key, 'tenants/tenant-alice/sessions/session-a/turns/turn-a/exports/report-1.json');
  assert.throws(() => connections.resolveForGrant(bob, {
    capabilityBroker: broker,
    grant,
    tool: 'dataset.summary',
    connectionId: 'source-alice',
  }), AuthorizationError);
  assert.throws(() => policy.assertReadable(bob, target.key), AuthorizationError);
});
