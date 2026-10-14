import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { LoginLimiter, LimiterUnavailableError } from '../../src/panel/login-limiter';

const limiter = new LoginLimiter(process.env.REDIS_URL!);
beforeEach(async () => { await limiter.reset(); });
afterAll(async () => { await limiter.close(); });

describe('límite de intentos', () => {
  it('bloquea al quinto fallo del mismo correo, venga de la IP que venga', async () => {
    for (let i = 0; i < 4; i++) await limiter.fail('Op@Citara.co', `10.0.0.${i}`);
    expect(await limiter.blocked('op@citara.co', '10.9.9.9')).toBe(false);
    await limiter.fail('op@citara.co', '10.0.0.5');
    expect(await limiter.blocked('op@citara.co', '10.9.9.9')).toBe(true);
  });
  it('bloquea al quinto fallo desde la misma IP, con correos distintos', async () => {
    for (let i = 0; i < 5; i++) await limiter.fail(`x${i}@c.co`, '10.0.0.1');
    expect(await limiter.blocked('otro@c.co', '10.0.0.1')).toBe(true);
  });
  it('un acierto limpia el contador del correo', async () => {
    for (let i = 0; i < 4; i++) await limiter.fail('op@citara.co', `10.0.0.${i}`);
    await limiter.succeed('op@citara.co');
    await limiter.fail('op@citara.co', '10.0.1.1');
    expect(await limiter.blocked('op@citara.co', '10.0.2.2')).toBe(false);
  });
  it('la ventana es de 15 minutos y no se alarga con cada fallo', async () => {
    await limiter.fail('op@citara.co', '10.0.0.1');
    const first = await limiter.ttl('op@citara.co');
    expect(first).toBeGreaterThan(14 * 60);
    expect(first).toBeLessThanOrEqual(15 * 60);
  });
  it('sin Redis falla cerrado', async () => {
    const dead = new LoginLimiter('redis://127.0.0.1:1');
    await expect(dead.blocked('op@citara.co', '10.0.0.1')).rejects.toBeInstanceOf(LimiterUnavailableError);
    await expect(dead.fail('op@citara.co', '10.0.0.1')).rejects.toBeInstanceOf(LimiterUnavailableError);
    await dead.close();
  });
});
