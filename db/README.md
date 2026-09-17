# PostgreSQL Production Baseline

[`001_tenant_isolation.sql`](./migrations/001_tenant_isolation.sql) defines the initial private-data schema and forces PostgreSQL Row-Level Security (RLS) on every tenant table.

The runtime database role must be separate from the migration owner, must not have `BYPASSRLS`, and must set the tenant only inside a transaction created from verified authentication claims:

```sql
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000001';
SELECT * FROM agent.datasets WHERE id = '...';
COMMIT;
```

Do not issue global-ID queries followed by an application-side ownership check. The query and policy must both constrain `tenant_id`. Apply this migration in a PostgreSQL 16+ test environment, then add an integration suite that attempts cross-tenant `SELECT`, `INSERT`, `UPDATE`, and `DELETE` with the application runtime role.
