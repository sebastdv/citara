// Aplica un archivo YAML de configuración de negocio: `pnpm tenant:apply ruta.yaml`.
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createDataSource } from '@citara/db';
import { applyTenantConfig } from './tenant-config';

async function main() {
  // --sin-banco publica un cambio del agente sin el banco de regresión (queda auditado).
  const skipBench = process.argv.includes('--sin-banco');
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Uso: pnpm tenant:apply <archivo.yaml> [--sin-banco]');
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');

  const ds = createDataSource(url);
  await ds.initialize();
  try {
    const r = await applyTenantConfig(ds, parse(await readFile(file, 'utf8')), { skipBench });
    console.log(`Negocio ${r.tenantId}: ${r.services} servicios, ${r.resources} recursos, ` +
                `${r.hours} bloques de horario, ${r.timeOff} ausencias, flujo ${r.flow ?? 'sin cambios'}, ` +
                `estado ${r.status}` +
                (r.agent ? `, agente v${r.agent.version}${r.agent.changed ? ' (nueva)' : ''}` : ''));
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
