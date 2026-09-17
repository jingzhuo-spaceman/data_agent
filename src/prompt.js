import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';
import { assertSafeText, immutableCopy } from './safe-payload.js';

/** Composes the model-visible context without exposing raw stores or secrets. */
export class PromptAssembler {
  constructor({ systemInstructions }) {
    this.systemInstructions = assertSafeText(systemInstructions, 'systemInstructions');
  }

  compose(context, { userMessage, memories = [] }) {
    const actor = assertActorContext(context);
    assertSafeText(userMessage, 'userMessage');
    if (!Array.isArray(memories)) throw new ValidationError('memories must be an array');

    const memoryContent = memories.map((memory) => {
      if (!memory || memory.tenantId !== actor.tenantId) {
        throw new ValidationError('Prompt memories must belong to the current tenant');
      }
      assertSafeText(memory.content, 'memory content');
      return { id: memory.id, content: memory.content };
    });

    return Object.freeze({
      messages: Object.freeze([
        Object.freeze({ role: 'system', content: this.systemInstructions }),
        ...memoryContent.map((memory) => Object.freeze({ role: 'system', content: `Relevant memory: ${memory.content}` })),
        Object.freeze({ role: 'user', content: userMessage }),
      ]),
      memoryIds: Object.freeze(memoryContent.map((memory) => memory.id)),
    });
  }
}
