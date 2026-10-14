import type { DataSource, EntityManager } from 'typeorm';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../panel/password';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalize = (email: string) => email.trim().toLowerCase();

function checkPassword(pw: string) {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}

/** Va por la conexión admin: la app no puede crear operadores. */
export async function createOperator(admin: DataSource, rawEmail: string, password: string): Promise<string> {
  const email = normalize(rawEmail);
  if (!EMAIL.test(email) || email.length > 255) throw new Error(`'${rawEmail}' no es un correo válido`);
  checkPassword(password);
  const hash = await hashPassword(password);
  try {
    const [o] = await admin.query(
      `INSERT INTO operators (email, password_hash) VALUES ($1, $2) RETURNING id`, [email, hash]);
    return o.id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new Error(`El operador '${email}' ya existe`);
    throw err;
  }
}

async function operatorId(m: EntityManager, email: string): Promise<string> {
  const [o] = await m.query(`SELECT id FROM operators WHERE lower(email) = $1`, [normalize(email)]);
  if (!o) throw new Error(`No existe el operador '${normalize(email)}'`);
  return o.id;
}

/** Cambia la clave y cierra todas sus sesiones: una clave filtrada deja de servir ya. */
export async function setOperatorPassword(admin: DataSource, email: string, password: string): Promise<void> {
  checkPassword(password);
  const hash = await hashPassword(password);
  await admin.transaction(async (m) => {
    const id = await operatorId(m, email);
    await m.query(`UPDATE operators SET password_hash = $2 WHERE id = $1`, [id, hash]);
    await m.query(`DELETE FROM operator_sessions WHERE operator_id = $1`, [id]);
  });
}

/** Le quita el acceso y cierra sus sesiones. */
export async function disableOperator(admin: DataSource, email: string): Promise<void> {
  await admin.transaction(async (m) => {
    const id = await operatorId(m, email);
    await m.query(`UPDATE operators SET disabled_at = now() WHERE id = $1`, [id]);
    await m.query(`DELETE FROM operator_sessions WHERE operator_id = $1`, [id]);
  });
}
