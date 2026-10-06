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
 * Tablas con `tenant_id` que a propósito NO llevan RLS.
 *
 * Las dos se leen o escriben ANTES de saber a qué tenant pertenece lo que llega,
 * así que una política que exija `app.tenant_id` las dejaría devolviendo cero
 * filas. La exención es correcta, pero tiene un precio: son las únicas tablas
 * donde la aplicación ve datos de todos los clientes a la vez.
 */
const EXENTAS_DE_RLS = new Set([
  // Se resuelve por phone_number_id antes de conocer el tenant.
  'whatsapp_channels',
  // Puerta de idempotencia: se inserta antes de resolver el tenant.
  'webhook_events',
]);

/**
 * Privilegios que `citara_app` puede tener sobre CADA tabla. Es una lista
 * cerrada a propósito: una tabla nueva que no aparezca aquí rompe la suite,
 * y esa es la idea.
 *
 * El motivo es que `ALTER DEFAULT PRIVILEGES` de la migración del rol otorga
 * SELECT/INSERT/UPDATE/DELETE a toda tabla nueva. Es un default generoso que
 * nadie vuelve a mirar: el privilegio de más no da error, no aparece en ningún
 * log y solo se nota el día que algo lo usa. Declararlo tabla por tabla obliga
 * a decidir, en vez de heredar.
 */
const PRESUPUESTO: Record<string, string[]> = {
  // Solo lectura: dar de alta o modificar tenants es del panel, no de la app.
  // Con DELETE, un borrado mal armado arrastraba en cascada contactos, canales,
  // conversaciones y mensajes del cliente, sin que RLS pudiera intervenir.
  tenants: ['SELECT'],
  // Tenant-scoped con RLS: la política ya filtra, la app opera con libertad.
  contacts: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  conversations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  messages: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  flows: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  conversation_sessions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  // Bitácora: la aplicación agrega, nunca corrige ni borra lo que pasó.
  audit_log: ['SELECT', 'INSERT'],
  // Agenda: tenant-scoped con RLS.
  services: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  resources: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  resource_services: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  // Exentas de RLS, y por eso lo más de solo-lectura posible.
  whatsapp_channels: ['SELECT'],
  webhook_events: ['SELECT', 'INSERT'],
  // Las migraciones las corre el administrador, nunca la aplicación.
  migrations: [],
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
      .filter((r) => !EXENTAS_DE_RLS.has(r.table_name));
    expect(desprotegidas).toEqual([]);
  });

  it('ninguna tabla da a citara_app más privilegios de los presupuestados', async () => {
    const tablas: Array<{ table_name: string }> = await ds.query(`
      SELECT c.relname AS table_name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname
    `);
    expect(tablas.length).toBeGreaterThan(0);

    const otorgados: Array<{ table_name: string; privilege_type: string }> = await ds.query(`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee = 'citara_app'
    `);

    const real = new Map<string, string[]>();
    for (const { table_name } of tablas) real.set(table_name, []);
    for (const g of otorgados) real.get(g.table_name)?.push(g.privilege_type);

    // Una tabla sin presupuesto declarado es un descuido, no un permiso.
    const sinDeclarar = [...real.keys()].filter((t) => !(t in PRESUPUESTO));
    expect(sinDeclarar).toEqual([]);

    const excesos = [...real.entries()]
      .map(([tabla, privs]) => ({
        tabla,
        demas: privs.filter((p) => !(PRESUPUESTO[tabla] ?? []).includes(p)).sort(),
      }))
      .filter((r) => r.demas.length > 0);
    expect(excesos).toEqual([]);
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

  it('sobre whatsapp_channels la app solo puede actualizar status e history_sync', async () => {
    // Los ecos de desconexión y el historial cambian el estado del canal desde
    // la aplicación. El GRANT es por columna: el token cifrado, el
    // phone_number_id y la WABA siguen siendo intocables para la app.
    const cols: { column_name: string }[] = await ds.query(`
      SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'whatsapp_channels'
         AND grantee = 'citara_app' AND privilege_type = 'UPDATE'
       ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['history_sync', 'status']);
  });
});
