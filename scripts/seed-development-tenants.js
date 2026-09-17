import { PostgresDatabase, requireDatabaseUrl } from '../src/postgres.js';
import { TenantRegistry } from '../src/postgres-state.js';

const tenants = [
  { id: '11111111-1111-4111-8111-111111111111', displayName: 'Alice 个人空间' },
  { id: '22222222-2222-4222-8222-222222222222', displayName: 'Bob 个人空间' },
  { id: '33333333-3333-4333-8333-333333333333', displayName: 'Carol 个人空间' },
];
const database = new PostgresDatabase({ databaseUrl: requireDatabaseUrl() });

try {
  const registry = new TenantRegistry({ database });
  for (const tenant of tenants) {
    await registry.create(tenant);
    console.log(`Ensured development tenant: ${tenant.id} (${tenant.displayName})`);
  }
} finally {
  await database.close();
}
