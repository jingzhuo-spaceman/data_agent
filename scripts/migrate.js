import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresDatabase, requireDatabaseUrl } from '../src/postgres.js';

const migrationDirectory = resolve('db/migrations');
const database = new PostgresDatabase({ databaseUrl: requireDatabaseUrl() });

try {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS agent');
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent.schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    for (const file of migrations) {
      const migrationId = file.replace(/\.sql$/, '');
      const applied = await client.query('SELECT 1 FROM agent.schema_migrations WHERE id = $1', [migrationId]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(resolve(migrationDirectory, file), 'utf8'));
        await client.query('INSERT INTO agent.schema_migrations (id) VALUES ($1)', [migrationId]);
        console.log(`Applied migration: ${migrationId}`);
      } else {
        console.log(`Migration already applied: ${migrationId}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await database.close();
}
