import type { DataSource } from 'typeorm';

export const APP_ROLE = 'citara_app';
const MIN_LENGTH = 24;

/**
 * Fija la contraseña de un rol de Postgres. La migración inicial crea
 * `citara_app` con la clave de desarrollo; en producción se cambia al migrar.
 * Va por format(%I, %L): el nombre y la clave se citan como identificador y
 * literal, nunca se interpolan en el SQL.
 */
export async function setRolePassword(admin: DataSource, role: string, password: string): Promise<void> {
  if (password.length < MIN_LENGTH || password === role) {
    throw new Error(`La contraseña de ${role} debe tener al menos ${MIN_LENGTH} caracteres y no ser la de desarrollo`);
  }
  const [exists] = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
  if (!exists) throw new Error(`El rol '${role}' no existe`);
  const [{ sql }] = await admin.query(`SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
  await admin.query(sql);
}
