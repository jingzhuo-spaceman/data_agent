import { ModelAdapter } from './model-adapter.js';
import { ValidationError } from './errors.js';

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

/**
 * Adapts OpenAI-compatible Chat Completions APIs, including DeepSeek. The API
 * key remains inside this adapter and is never added to prompts or events.
 */
export class OpenAICompatibleModelAdapter extends ModelAdapter {
  constructor({ name = 'openai-compatible', apiKey, baseUrl, model, fetchImpl = fetch }) {
    requiredText(apiKey, 'MODEL_API_KEY');
    requiredText(baseUrl, 'MODEL_BASE_URL');
    requiredText(model, 'MODEL_NAME');
    if (typeof fetchImpl !== 'function') throw new ValidationError('fetchImpl is required');
    const endpoint = new URL('chat/completions', `${baseUrl.replace(/\/+$/, '')}/`).toString();

    super({
      name,
      respond: async ({ messages }) => {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, messages, stream: false }),
        });
        if (!response.ok) {
          throw new Error(`Model provider request failed with status ${response.status}`);
        }
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new ValidationError('Model provider response did not contain assistant content');
        }
        return { message: content };
      },
    });
    this.model = model;
  }
}

export function modelAdapterFromEnvironment(environment = process.env) {
  const { MODEL_API_KEY: apiKey, MODEL_BASE_URL: baseUrl } = environment;
  const model = environment.MODEL_NAME || 'deepseek-chat';
  if (!apiKey || !baseUrl) return null;
  return new OpenAICompatibleModelAdapter({ apiKey, baseUrl, model });
}
