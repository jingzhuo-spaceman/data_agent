import { ValidationError } from './errors.js';

const SECRET_KEY = /(api[-_]?key|secret|token|authorization|cookie|password|credential)/i;
const SECRET_TEXT = /(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+\S+|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*\S+)/i;

/**
 * Events are intentionally a low-sensitivity audit surface. Fail closed when
 * a payload claims to contain a credential rather than silently persisting it.
 */
export function assertSafeEventPayload(value, path = 'payload') {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEventPayload(item, `${path}[${index}]`));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        throw new ValidationError(`Sensitive field is not allowed in event payload: ${path}.${key}`);
      }
      assertSafeEventPayload(nested, `${path}.${key}`);
    }
  }
}

export function immutableCopy(value) {
  return structuredClone(value);
}

/** Reject obvious credential material before it enters memory, prompts, or logs. */
export function assertSafeText(value, name = 'text') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  if (SECRET_TEXT.test(value)) {
    throw new ValidationError(`${name} appears to contain a secret`);
  }
  return value;
}
