export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthorizationError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class CapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}
