import { config } from 'dotenv';
import { createDataSource } from './packages/db/src/data-source';
import { testEnv } from './vitest.test-env';

/** Crea la base de tests si no existe. Las migraciones las corren los helpers. */
export default async function setup() {
  config();
  const target = new URL(testEnv(process.env).DATABASE_ADMIN_URL!);
  const dbName = target.pathname.slice(1);
  const server = new URL(target);
  server.pathname = '/postgres';

  const ds = createDataSource(server.toString());
  await ds.initialize();
  try {
    const [exists] = await ds.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!exists) await ds.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await ds.destroy();
  }
}
