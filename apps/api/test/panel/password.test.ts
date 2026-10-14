import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, dummyHash } from '../../src/panel/password';

describe('contraseñas', () => {
  it('verifica la correcta y rechaza otra', async () => {
    const h = await hashPassword('clave-de-prueba-123');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('clave-de-prueba-123', h)).toBe(true);
    expect(await verifyPassword('clave-de-prueba-124', h)).toBe(false);
  });
  it('dos hashes de la misma clave difieren (sal)', async () => {
    expect(await hashPassword('x'.repeat(12))).not.toBe(await hashPassword('x'.repeat(12)));
  });
  it('un hash malformado o con parámetros fuera de rango no verifica ni lanza', async () => {
    expect(await verifyPassword('x', 'basura')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$8$1$aa$bb')).toBe(false);
    expect(await verifyPassword('x', `scrypt$${2 ** 30}$8$1$aa$bb`)).toBe(false);
  });
  it('el señuelo es un hash válido que no coincide con una clave vacía', async () => {
    expect(await dummyHash()).toMatch(/^scrypt\$/);
    expect(await verifyPassword('', await dummyHash())).toBe(false);
  });
});
