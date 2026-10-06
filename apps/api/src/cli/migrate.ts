// Aplica las migraciones pendientes con la conexión ADMIN. La aplicación
// (`citara_app`) no tiene privilegios para hacerlo, y no debe tenerlos.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { createDataSource } from '@citara/db';

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');
  const ds = createDataSource(url);
  await ds.initialize();
  try {
    const applied = await ds.runMigrations();
    console.log(applied.length
      ? `Migraciones aplicadas: ${applied.map((m) => m.name).join(', ')}`
      : 'Sin migraciones pendientes');
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
