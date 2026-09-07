import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recorta los privilegios que `ALTER DEFAULT PRIVILEGES` regaló de más.
 *
 * La migración del rol otorga SELECT/INSERT/UPDATE/DELETE sobre toda tabla
 * nueva. Para las tablas con RLS eso está bien: la política filtra por tenant.
 * Pero `tenants` NO lleva RLS —se lee sin contexto desde la resolución de canal
 * y los barridos de recordatorios— así que ahí el default quedó como un
 * privilegio sin ningún freno.
 *
 * Medido antes de escribir esto: desde el rol de la aplicación y sin contexto
 * de tenant, un `DELETE FROM tenants` borraba el tenant y arrastraba en cascada
 * sus contactos, canales, conversaciones y mensajes. Un solo DELETE mal armado
 * en el camino de la app se lleva la historia entera de un cliente, y RLS no
 * interviene porque `tenants` es justamente la tabla que no la tiene.
 *
 * La aplicación solo necesita LEER tenants. Darlos de alta o modificarlos es
 * trabajo del panel de administración (fases 5 y 6); cuando exista, que pida
 * su GRANT de forma explícita y deliberada, no heredado de un default.
 *
 * `migrations` queda sin nada: las migraciones las corre el rol administrador,
 * nunca la aplicación.
 */
export class RestrictAppPrivileges1725300700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON tenants FROM citara_app`);
    await q.query(`REVOKE ALL ON migrations FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`GRANT INSERT, UPDATE, DELETE ON tenants TO citara_app`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON migrations TO citara_app`);
  }
}
