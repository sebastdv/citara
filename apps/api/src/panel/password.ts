import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
// 128·N·r = 32 MiB: justo el maxmem por defecto de Node, que lo rechaza.
const MAXMEM = 64 * 1024 * 1024;

const scrypt = (pw: string, salt: Buffer, opts: ScryptOptions) =>
  new Promise<Buffer>((ok, ko) =>
    scryptCb(pw.normalize('NFKC'), salt, KEYLEN, opts, (e, k) => (e ? ko(e) : ok(k))));

/** `scrypt$N$r$p$sal$hash`: los parámetros viajan con el hash para poder subirlos sin migrar. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  // Parámetros fuera de rango: un hash corrupto, o uno que tumbaría el proceso.
  if (!(n >= 2 ** 14 && n <= 2 ** 17 && (n & (n - 1)) === 0 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEYLEN) return false;
  const key = await scrypt(pw, Buffer.from(parts[4], 'base64url'), { N: n, r, p, maxmem: 128 * n * r * 2 });
  return timingSafeEqual(key, expected);
}

let dummy: Promise<string> | null = null;
/** Para un correo que no existe: se verifica contra esto y tarda lo mismo que una clave mala. */
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));
/** ¿Ya se empezó a calcular? El login lo arranca al iniciar el módulo. */
export const dummyHashStarted = () => dummy !== null;
