import { ValidationError } from './errors.js';

function requireDatasetId(input) {
  if (!input || typeof input.datasetId !== 'string' || input.datasetId.trim() === '') {
    throw new ValidationError('datasetId is required');
  }
  return { datasetId: input.datasetId };
}

/** A read-only example capability. It intentionally returns metadata, not rows. */
export const dataCatalogPlugin = {
  manifest: {
    name: 'data-catalog',
    version: '0.1.0',
    capabilities: ['dataset.summary'],
    requiredPermissions: ['dataset:read'],
    apiVersion: '1',
  },
  register({ registerTool }) {
    registerTool({
      name: 'dataset.summary',
      validate: requireDatasetId,
      execute: ({ input, execution }) => {
        const dataset = execution.readResource(input.datasetId);
        if (dataset.type !== 'dataset') {
          throw new ValidationError('resource is not a dataset');
        }
        const rows = Array.isArray(dataset.data.rows) ? dataset.data.rows : [];
        const firstRow = rows[0] && typeof rows[0] === 'object' ? rows[0] : {};
        return {
          datasetId: dataset.id,
          fieldNames: Object.keys(firstRow),
          rowCount: rows.length,
          createdAt: dataset.createdAt,
        };
      },
    });
    return { dispose() {} };
  },
};

function requireAggregateInput(input) {
  if (!input || typeof input.datasetId !== 'string' || typeof input.operation !== 'string') {
    throw new ValidationError('datasetId and operation are required');
  }
  if (!['count', 'sum', 'average'].includes(input.operation)) {
    throw new ValidationError('operation must be count, sum, or average');
  }
  if (input.operation !== 'count' && (typeof input.field !== 'string' || input.field.trim() === '')) {
    throw new ValidationError('field is required for sum and average');
  }
  return { datasetId: input.datasetId, operation: input.operation, field: input.field };
}

/** Analysis runs through a Worker contract instead of the plugin process directly. */
export const dataAnalysisPlugin = {
  manifest: {
    name: 'data-analysis',
    version: '0.1.0',
    capabilities: ['dataset.aggregate'],
    requiredPermissions: ['dataset:read', 'analysis:execute'],
    apiVersion: '1',
  },
  register({ registerTool }) {
    registerTool({
      name: 'dataset.aggregate',
      validate: requireAggregateInput,
      execute: ({ input, execution }) => execution.runWorker({
        operation: 'dataset.aggregate',
        resourceIds: [input.datasetId],
        input,
      }),
    });
    return { dispose() {} };
  },
};
