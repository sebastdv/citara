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
 * Tablas con `tenant_id` que a propósito NO llevan RLS, con el privilegio máximo
 * que `citara_app` puede tener sobre cada una.
 *
 * Las dos se leen o escriben ANTES de saber a qué tenant pertenece lo que llega,
 * así que una política que exija `app.tenant_id` las dejaría devolviendo cero
 * filas. La exención es correcta, pero tiene un precio: son las únicas tablas
 * donde la aplicación ve datos de todos los clientes a la vez. El contrapeso es
 * que sean lo más de solo-lectura posible, y eso es lo que se verifica abajo.
 */
const EXENTAS: Record<string, string[]> = {
  // Se resuelve por phone_number_id antes de conocer el tenant. Solo lectura:
  // la aplicación nunca da de alta ni modifica canales, eso es del panel.
  whatsapp_channels: ['SELECT'],
  // Puerta de idempotencia: se inserta antes de resolver el tenant. Nunca se
  // actualiza ni se borra — un evento ya visto es historia, no estado mutable.
  webhook_events: ['SELECT', 'INSERT'],
};

describe('invariante: toda tabla con tenant_id lleva RLS', () => {
  it('no deja ninguna tabla tenant-scoped sin ENABLE y FORCE', async () => {
    const rows: Array<{ table_name: string; enabled: boolean; forced: boolean }> =
      await ds.query(`
        SELECT c.relname            AS table_name,
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

    const desprotegidas = rows
      .filter((r) => !r.enabled || !r.forced)
      .filter((r) => !(r.table_name in EXENTAS));
    expect(desprotegidas).toEqual([]);
  });

  it('las tablas exentas de RLS no tienen más privilegios de los declarados', async () => {
    // La exención de RLS solo es defendible si esas tablas son de lectura (o de
    // solo-inserción). El `ALTER DEFAULT PRIVILEGES` de la migración del rol da
    // SELECT/INSERT/UPDATE/DELETE a toda tabla nueva, así que sin un REVOKE
    // explícito una tabla exenta queda escribible entera por la aplicación: un
    // fallo en el camino de la app podría reescribir el token de otro cliente.
    for (const [tabla, permitidos] of Object.entries(EXENTAS)) {
      const existe = await ds.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`, [tabla]);
      if (existe.length === 0) continue; // aún no la crea ninguna migración

      const otorgados: Array<{ privilege_type: string }> = await ds.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'citara_app'`,
        [tabla],
      );
      const demas = otorgados
        .map((g) => g.privilege_type)
        .filter((p) => !permitidos.includes(p));
      expect({ tabla, demas }).toEqual({ tabla, demas: [] });
    }
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
