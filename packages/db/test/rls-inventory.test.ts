import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDataSource } from '../src/data-source';
import type { DataSource } from 'typeorm';

let ds: DataSource;

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_ADMIN_URL!);
  await ds.initialize();
  await ds.runMigrations();
});

afterAll(async () => { await ds.destroy(); });

/**
 * Guardia de invariante, no test de una tarea concreta.
 *
 * La migración del rol dejó un `ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
 * INSERT, UPDATE, DELETE ON TABLES TO citara_app`. Eso significa que toda tabla
 * nueva nace con permisos completos para la aplicación. Si una migración futura
 * crea una tabla con `tenant_id` y se le olvida llamar a `tenantRlsSql`, el
 * resultado NO es un error de permisos ruidoso: es una tabla que `citara_app`
 * lee y escribe entera, sin filtro de tenant, en silencio. Es decir, una fuga
 * entre clientes que ningún test existente detecta.
 *
 * Este test invierte la carga de la prueba: en vez de acordarse de verificar
 * cada tabla nueva, enumera las que tienen `tenant_id` y exige que todas lleven
 * RLS. Una tabla nueva sin política rompe la suite el día que se crea.
 */
describe('invariante: toda tabla con tenant_id lleva RLS', () => {
  it('no deja ninguna tabla tenant-scoped sin ENABLE y FORCE', async () => {
    const rows: Array<{ table_name: string; enabled: boolean; forced: boolean }> =
      await ds.query(`
        SELECT c.relname       AS table_name,
               c.relrowsecurity     AS enabled,
               c.relforcerowsecurity AS forced
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND EXISTS (
                 SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public'
                    AND col.table_name = c.relname
                    AND col.column_name = 'tenant_id')
         ORDER BY c.relname
      `);

    // Sin esta aserción el test pasaría en verde si la consulta dejara de
    // encontrar tablas — un guardia que se apaga solo no guarda nada.
    expect(rows.length).toBeGreaterThan(0);

    const desprotegidas = rows.filter((r) => !r.enabled || !r.forced);
    expect(desprotegidas).toEqual([]);
  });

  it('la tabla raíz tenants queda fuera del inventario a propósito', async () => {
    // `tenants` no tiene columna `tenant_id`: es la raíz. Se lee sin contexto
    // desde la resolución de canal y los barridos de recordatorios, así que
    // ponerle RLS la dejaría devolviendo cero filas. Esta aserción documenta
    // que su ausencia del inventario es una decisión, no un descuido.
    const [row] = await ds.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenants'`,
    );
    expect(row.relrowsecurity).toBe(false);
    expect(row.relforcerowsecurity).toBe(false);
  });
});
