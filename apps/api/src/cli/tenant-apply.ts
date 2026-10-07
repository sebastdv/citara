// Aplica un archivo YAML de configuración de negocio: `pnpm tenant:apply ruta.yaml`.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createDataSource } from '@citara/db';
import { applyTenantConfig } from './tenant-config';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Uso: pnpm tenant:apply <archivo.yaml>');
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');

  const ds = createDataSource(url);
  await ds.initialize();
  try {
    const r = await applyTenantConfig(ds, parse(await readFile(file, 'utf8')));
    console.log(`Negocio ${r.tenantId}: ${r.services} servicios, ${r.resources} recursos, ` +
                `${r.hours} bloques de horario, ${r.timeOff} ausencias, flujo ${r.flow ?? 'sin cambios'}, ` +
                `estado ${r.status}`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
