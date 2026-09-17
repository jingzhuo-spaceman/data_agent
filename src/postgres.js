import pg from 'pg';
import { assertActorContext } from './actor-context.js';
import { ValidationError } from './errors.js';

const { Pool } = pg;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireDatabaseUrl(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new ValidationError('DATABASE_URL is required');
  }
  return databaseUrl;
}

/** A narrow PostgreSQL adapter used by the migration runner and health endpoint. */
export class PostgresDatabase {
  constructor({ databaseUrl }) {
    this.pool = new Pool({ connectionString: requireDatabaseUrl({ DATABASE_URL: databaseUrl }) });
  }

  async healthcheck() {
    const result = await this.pool.query('SELECT current_database() AS database_name, current_user AS user_name');
    return result.rows[0];
  }

  async withTenant(context, operation) {
    const actor = assertActorContext(context);
    if (!UUID.test(actor.tenantId)) {
      throw new ValidationError('PostgreSQL tenantId must be a UUID');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [actor.tenantId]);
      const result = await operation(client, actor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
