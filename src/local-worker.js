import { assertActorContext } from './actor-context.js';
import { CapabilityError, ValidationError } from './errors.js';
import { assertSafeEventPayload, immutableCopy } from './safe-payload.js';

function aggregate(rows, field, operation) {
  if (operation === 'count') return rows.length;
  const values = rows.map((row) => row[field]).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) throw new ValidationError(`No numeric values found for field: ${field}`);
  const sum = values.reduce((total, value) => total + value, 0);
  return operation === 'sum' ? sum : sum / values.length;
}

/**
 * Local reference worker. It models the signed-grant input/output contract;
 * production must move this implementation into a sandboxed process/container.
 */
export class LocalAnalysisWorker {
  constructor({ capabilityBroker, resourceStore }) {
    this.capabilityBroker = capabilityBroker;
    this.resourceStore = resourceStore;
  }

  execute(context, { grant, tool, operation, input }) {
    const actor = assertActorContext(context);
    if (operation !== 'dataset.aggregate') {
      throw new CapabilityError(`Unsupported worker operation: ${operation}`);
    }
    if (!input || typeof input.datasetId !== 'string' || typeof input.operation !== 'string') {
      throw new ValidationError('dataset aggregate input is invalid');
    }
    const field = input.field;
    if (!['count', 'sum', 'average'].includes(input.operation)) {
      throw new ValidationError('operation must be count, sum, or average');
    }
    if (input.operation !== 'count' && (typeof field !== 'string' || field.trim() === '')) {
      throw new ValidationError('field is required for sum and average');
    }
    this.capabilityBroker.assertUsable(actor, grant, {
      tool,
      resourceIds: [input.datasetId],
    });
    const dataset = this.resourceStore.get(actor, input.datasetId);
    if (!dataset || dataset.type !== 'dataset') {
      throw new ValidationError('resource is not a dataset');
    }
    const rows = Array.isArray(dataset.data.rows) ? dataset.data.rows : [];
    const result = Object.freeze({
      datasetId: dataset.id,
      operation: input.operation,
      field: field ?? null,
      value: aggregate(rows, field, input.operation),
      objectPrefix: `tenants/${actor.tenantId}/sessions/${grant.sessionId}/turns/${grant.turnId}`,
    });
    assertSafeEventPayload(result, 'worker result');
    return immutableCopy(result);
  }
}
