// pnpm operator <create|password|disable> <correo>
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { createInterface } from 'node:readline';
import { createDataSource } from '@citara/db';
import { createOperator, disableOperator, enableOperator, setOperatorPassword } from './operators';

const USAGE = `Uso:
  pnpm operator create <correo>     crea el operador del panel (pide la contraseña)
  pnpm operator password <correo>   cambia la contraseña y cierra sus sesiones
  pnpm operator disable <correo>    le quita el acceso y cierra sus sesiones
  pnpm operator enable <correo>     le devuelve el acceso (con la contraseña de antes)`;

/** Lee una línea sin mostrarla en la terminal. */
function readHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  // readline escribe por aquí lo que se teclea: callarlo es lo que quita el eco.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return new Promise((ok) => rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); ok(answer); }));
}

async function askPassword(): Promise<string> {
  const a = await readHidden('Contraseña: ');
  const b = await readHidden('Repítela: ');
  if (a !== b) throw new Error('Las contraseñas no coinciden');
  return a;
}

async function main() {
  const [cmd, email] = process.argv.slice(2);
  if (!cmd || !email || !['create', 'password', 'disable', 'enable'].includes(cmd)) throw new Error(USAGE);
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');
  // La contraseña se pide antes de conectar: no se deja una conexión abierta esperando al teclado.
  const password = cmd === 'disable' || cmd === 'enable' ? '' : await askPassword();
  const admin = createDataSource(url);
  await admin.initialize();
  try {
    if (cmd === 'create') {
      await createOperator(admin, email, password);
      console.log(`Operador '${email.trim().toLowerCase()}' creado. Entra en /panel/login.`);
    } else if (cmd === 'password') {
      await setOperatorPassword(admin, email, password);
      console.log('Contraseña cambiada. Sus sesiones abiertas se cerraron.');
    } else if (cmd === 'enable') {
      console.log(await enableOperator(admin, email)
        ? 'Operador habilitado de nuevo, con su contraseña de antes (si la deshabilitaste por una filtración, cámbiala: pnpm operator password).'
        : 'Ese operador ya estaba habilitado.');
    } else {
      await disableOperator(admin, email);
      console.log('Operador deshabilitado. Sus sesiones abiertas se cerraron.');
    }
  } finally {
    await admin.destroy();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
