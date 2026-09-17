import { randomUUID } from 'node:crypto';
import { assertActorContext } from './actor-context.js';
import { AuthorizationError, CapabilityError, ValidationError } from './errors.js';
import { assertSafeEventPayload, assertSafeText, immutableCopy } from './safe-payload.js';

/**
 * Default Turn/Step pipeline. Model integration can emit ToolProposal objects
 * into runToolTurn() without gaining direct access to a tool implementation.
 */
export class AgentHarness {
  constructor({ eventLog, capabilityBroker, pluginRegistry, resourceStore, memoryStore = null, promptAssembler = null, modelAdapter = null, worker = null, connectionCatalog = null }) {
    if (!eventLog || !capabilityBroker || !pluginRegistry || !resourceStore) {
      throw new ValidationError('eventLog, capabilityBroker, pluginRegistry, and resourceStore are required');
    }
    this.eventLog = eventLog;
    this.capabilityBroker = capabilityBroker;
    this.pluginRegistry = pluginRegistry;
    this.resourceStore = resourceStore;
    this.memoryStore = memoryStore;
    this.promptAssembler = promptAssembler;
    this.modelAdapter = modelAdapter;
    this.worker = worker;
    this.connectionCatalog = connectionCatalog;
  }

  createSession(context) {
    return this.eventLog.createSession(context);
  }

  runToolTurn(context, { sessionId, toolName, input, resourceIds = [], connectionId = null, maxNetworkRequests = 0 }) {
    const actor = assertActorContext(context);
    const turnId = randomUUID();
    const stepId = randomUUID();
    let grant;

    this.eventLog.append(actor, { sessionId, turnId, type: 'turn.started', payload: {} });
    this.eventLog.append(actor, { sessionId, turnId, type: 'step.started', payload: { stepId } });
    this.eventLog.append(actor, {
      sessionId,
      turnId,
      type: 'tool.call.proposed',
      payload: { stepId, toolName, resourceIds: [...resourceIds] },
    });

    try {
      const tool = this.pluginRegistry.require(toolName);
      const validatedInput = tool.validate(immutableCopy(input));
      if (connectionId !== null && !this.connectionCatalog) {
        throw new ValidationError('A connection catalog is required for connection-backed tools');
      }
      if (connectionId !== null && !this.connectionCatalog.get(actor, connectionId)) {
        throw new AuthorizationError();
      }
      grant = this.capabilityBroker.authorize(actor, {
        sessionId,
        turnId,
        tool: toolName,
        resourceIds,
        connectionId,
        maxNetworkRequests,
      });
      this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'tool.authorized',
        payload: { stepId, toolName, grantId: grant.grantId },
      });

      const execution = Object.freeze({
        grant,
        readResource: (resourceId) => {
          this.capabilityBroker.assertUsable(actor, grant, {
            tool: toolName,
            resourceIds: [resourceId],
          });
          const resource = this.resourceStore.get(actor, resourceId);
          if (!resource) throw new AuthorizationError();
          return resource;
        },
        runWorker: ({ operation, resourceIds: workerResourceIds, input: workerInput }) => {
          if (!this.worker) throw new CapabilityError('No worker is configured');
          this.capabilityBroker.assertUsable(actor, grant, {
            tool: toolName,
            resourceIds: workerResourceIds,
          });
          return this.worker.execute(actor, {
            grant,
            tool: toolName,
            operation,
            input: workerInput,
          });
        },
      });
      const result = tool.execute({ input: validatedInput, execution });
      assertSafeEventPayload(result, 'toolResult');
      const safeResult = immutableCopy(result);
      this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'tool.result',
        payload: { stepId, toolName, result: safeResult },
      });
      this.eventLog.append(actor, { sessionId, turnId, type: 'step.ended', payload: { stepId, status: 'completed' } });
      this.eventLog.append(actor, { sessionId, turnId, type: 'turn.ended', payload: { status: 'completed' } });
      return Object.freeze({ turnId, stepId, result: safeResult });
    } catch (error) {
      const denied = error instanceof AuthorizationError || error instanceof CapabilityError;
      this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: denied ? 'tool.denied' : 'tool.failed',
        payload: { stepId, toolName, reason: error.name },
      });
      this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'step.ended',
        payload: { stepId, status: denied ? 'denied' : 'failed' },
      });
      this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'turn.ended',
        payload: { status: denied ? 'denied' : 'failed' },
      });
      throw error;
    } finally {
      if (grant) this.capabilityBroker.revoke(grant.grantId);
    }
  }

  async runModelTurn(context, { sessionId, userMessage }) {
    const actor = assertActorContext(context);
    if (!this.memoryStore || !this.promptAssembler || !this.modelAdapter) {
      throw new ValidationError('memoryStore, promptAssembler, and modelAdapter are required for model turns');
    }
    assertSafeText(userMessage, 'userMessage');
    const turnId = randomUUID();
    const stepId = randomUUID();
    await this.eventLog.append(actor, { sessionId, turnId, type: 'turn.started', payload: {} });
    await this.eventLog.append(actor, { sessionId, turnId, type: 'step.started', payload: { stepId } });
    await this.eventLog.append(actor, { sessionId, turnId, type: 'user.message', payload: { stepId, content: userMessage } });

    try {
      let memories = [];
      try {
        memories = await this.memoryStore.retrieve(actor, userMessage);
      } catch (memoryError) {
        await this.eventLog.append(actor, {
          sessionId,
          turnId,
          type: 'memory.retrieval.failed',
          payload: { stepId, provider: this.memoryStore.constructor.name, reason: memoryError.name },
        });
      }
      const prompt = this.promptAssembler.compose(actor, { userMessage, memories });
      await this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'memory.retrieved',
        payload: { stepId, memoryIds: prompt.memoryIds },
      });
      await this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'model.requested',
        payload: { stepId, provider: this.modelAdapter.name, messageCount: prompt.messages.length },
      });
      const response = await this.modelAdapter.complete({ messages: prompt.messages });
      await this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'assistant.message',
        payload: { stepId, content: response.message, provider: response.provider },
      });
      if (typeof this.memoryStore.recordTurn === 'function') {
        try {
          await this.memoryStore.recordTurn(actor, {
            sessionId,
            turnId,
            userMessage,
            assistantMessage: response.message,
          });
          await this.eventLog.append(actor, {
            sessionId,
            turnId,
            type: 'memory.recorded',
            payload: { stepId, provider: this.memoryStore.constructor.name },
          });
        } catch (memoryError) {
          await this.eventLog.append(actor, {
            sessionId,
            turnId,
            type: 'memory.record.failed',
            payload: { stepId, provider: this.memoryStore.constructor.name, reason: memoryError.name },
          });
        }
      }
      await this.eventLog.append(actor, { sessionId, turnId, type: 'step.ended', payload: { stepId, status: 'completed' } });
      await this.eventLog.append(actor, { sessionId, turnId, type: 'turn.ended', payload: { status: 'completed' } });
      return Object.freeze({ turnId, stepId, message: response.message, memoryIds: prompt.memoryIds });
    } catch (error) {
      await this.eventLog.append(actor, {
        sessionId,
        turnId,
        type: 'model.failed',
        payload: { stepId, reason: error.name },
      });
      await this.eventLog.append(actor, { sessionId, turnId, type: 'step.ended', payload: { stepId, status: 'failed' } });
      await this.eventLog.append(actor, { sessionId, turnId, type: 'turn.ended', payload: { status: 'failed' } });
      throw error;
    }
  }
}
