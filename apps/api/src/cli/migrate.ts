// Aplica las migraciones pendientes con la conexión ADMIN. La aplicación
// (`citara_app`) no tiene privilegios para hacerlo, y no debe tenerlos.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { createDataSource } from '@citara/db';
import { APP_ROLE, setRolePassword } from './app-role';

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
    // En producción la app no entra con la clave de desarrollo que le puso la
    // migración del rol: se fija la de APP_DB_PASSWORD en cada despliegue.
    if (process.env.APP_DB_PASSWORD) {
      await setRolePassword(ds, APP_ROLE, process.env.APP_DB_PASSWORD);
      console.log(`Contraseña de ${APP_ROLE} fijada desde APP_DB_PASSWORD`);
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
