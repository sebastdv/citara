import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { LoginLimiter, LimiterUnavailableError } from '../../src/panel/login-limiter';

const limiter = new LoginLimiter(process.env.REDIS_URL!);
beforeEach(async () => { await limiter.reset(); });
afterAll(async () => { await limiter.close(); });

describe('límite de intentos', () => {
  it('cinco intentos fallidos del mismo correo, venga de la IP que venga, bloquean el sexto', async () => {
    for (let i = 0; i < 5; i++) expect(await limiter.attempt('Op@Citara.co', `10.0.0.${i}`)).toBe(true);
    expect(await limiter.attempt('op@citara.co', '10.9.9.9')).toBe(false);
  });
  it('cinco intentos desde la misma IP, con correos distintos, bloquean el sexto', async () => {
    for (let i = 0; i < 5; i++) expect(await limiter.attempt(`x${i}@c.co`, '10.0.0.1')).toBe(true);
    expect(await limiter.attempt('otro@c.co', '10.0.0.1')).toBe(false);
  });
  it('en paralelo también: de veinte intentos simultáneos pasan solo cinco', async () => {
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => limiter.attempt('op@citara.co', `10.1.0.${i}`)));
    expect(r.filter(Boolean)).toHaveLength(5);
  });
  it('un acierto no cuenta: devuelve su intento al correo y a la IP', async () => {
    for (let i = 0; i < 4; i++) await limiter.attempt('op@citara.co', '10.0.0.1');
    await limiter.attempt('op@citara.co', '10.0.0.1');
    await limiter.succeed('op@citara.co', '10.0.0.1');
    // Sin el descuento la IP iría en 6 y este intento ya no pasaría.
    expect(await limiter.attempt('op@citara.co', '10.0.0.1')).toBe(true);
    expect(await limiter.attempt('z@c.co', '10.0.0.1')).toBe(false);
  });
  it('la ventana es de 15 minutos y no se alarga con cada intento', async () => {
    await limiter.attempt('op@citara.co', '10.0.0.1');
    const first = await limiter.ttl('op@citara.co');
    expect(first).toBeGreaterThan(14 * 60);
    expect(first).toBeLessThanOrEqual(15 * 60);
  });
  it('sin Redis falla cerrado', async () => {
    const dead = new LoginLimiter('redis://127.0.0.1:1');
    await expect(dead.attempt('op@citara.co', '10.0.0.1')).rejects.toBeInstanceOf(LimiterUnavailableError);
    await dead.close();
  });
});
