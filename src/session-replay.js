import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';

/** Builds a user-visible timeline from durable events without re-executing tools. */
export class SessionReplay {
  constructor({ eventLog }) {
    if (!eventLog || typeof eventLog.list !== 'function') {
      throw new ValidationError('eventLog with list() is required');
    }
    this.eventLog = eventLog;
  }

  replay(context, sessionId) {
    const actor = assertActorContext(context);
    const turns = new Map();
    for (const event of this.eventLog.list(actor, sessionId)) {
      if (!turns.has(event.turnId)) {
        turns.set(event.turnId, { turnId: event.turnId, status: 'running', steps: new Map(), timeline: [] });
      }
      const turn = turns.get(event.turnId);
      turn.timeline.push(Object.freeze({ type: event.type, timestamp: event.timestamp }));
      const stepId = event.payload.stepId;
      if (event.type === 'step.started' && stepId) {
        turn.steps.set(stepId, { stepId, status: 'running' });
      }
      if (event.type === 'step.ended' && stepId) {
        turn.steps.set(stepId, { stepId, status: event.payload.status });
      }
      if (event.type === 'turn.ended') turn.status = event.payload.status;
    }
    return Object.freeze([...turns.values()].map((turn) => Object.freeze({
      turnId: turn.turnId,
      status: turn.status,
      steps: Object.freeze([...turn.steps.values()].map(Object.freeze)),
      timeline: Object.freeze(turn.timeline),
    })));
  }
}
