import { ValidationError } from './errors.js';
import { assertSafeText } from './safe-payload.js';

/**
 * A replaceable model boundary. The adapter receives only prompt messages,
 * never a TenantStore, Secret resolver, or unrestricted tool executor.
 */
export class ModelAdapter {
  constructor({ name, respond }) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ValidationError('model adapter name is required');
    }
    if (typeof respond !== 'function') {
      throw new ValidationError('model adapter respond() is required');
    }
    this.name = name;
    this.respond = respond;
  }

  async complete({ messages }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError('model messages are required');
    }
    for (const message of messages) {
      if (!message || typeof message.role !== 'string') throw new ValidationError('invalid model message');
      assertSafeText(message.content, 'model message');
    }
    const response = await this.respond(Object.freeze({ messages: Object.freeze([...messages]) }));
    if (!response || typeof response.message !== 'string') {
      throw new ValidationError('model response must contain a message');
    }
    assertSafeText(response.message, 'model response');
    return Object.freeze({ provider: this.name, message: response.message });
  }
}
