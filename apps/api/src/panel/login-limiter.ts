import { createHash } from 'node:crypto';
import Redis from 'ioredis';

export const MAX_FAILURES = 5;
export const WINDOW_SECONDS = 15 * 60;
const PREFIX = 'panel-login:';

export class LimiterUnavailableError extends Error {}

/**
 * Fallos de login por correo y por IP (spec §3.7.1). Sin Redis no se sabe si
 * alguien está probando contraseñas: el login falla cerrado.
 */
export class LoginLimiter {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 1000, lazyConnect: true });
    // Se reporta en cada llamada; sin listener, un corte tumbaría el proceso.
    this.redis.on('error', () => {});
  }

  private keys(email: string, ip: string) {
    const e = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    return { email: `${PREFIX}email:${e}`, ip: `${PREFIX}ip:${ip}` };
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) { throw new LimiterUnavailableError((err as Error).message); }
  }

  blocked(email: string, ip: string): Promise<boolean> {
    const k = this.keys(email, ip);
    return this.run(async () => (await this.redis.mget(k.email, k.ip)).some((v) => Number(v) >= MAX_FAILURES));
  }

  fail(email: string, ip: string): Promise<void> {
    const k = this.keys(email, ip);
    // SET NX EX fija la ventana con el primer fallo; INCR no la alarga.
    return this.run(async () => {
      const res = await this.redis.multi()
        .set(k.email, '0', 'EX', WINDOW_SECONDS, 'NX').incr(k.email)
        .set(k.ip, '0', 'EX', WINDOW_SECONDS, 'NX').incr(k.ip)
        .exec();
      const failed = res?.find(([err]) => err);
      if (!res || failed) throw failed?.[0] ?? new Error('la transacción de Redis no corrió');
    });
  }

  succeed(email: string): Promise<void> {
    return this.run(async () => { await this.redis.del(this.keys(email, '-').email); });
  }

  /** Para los tests. */
  ttl(email: string): Promise<number> { return this.run(() => this.redis.ttl(this.keys(email, '-').email)); }

  /** Para los tests. */
  reset(): Promise<void> {
    return this.run(async () => {
      const keys = await this.redis.keys(`${PREFIX}*`);
      if (keys.length) await this.redis.del(...keys);
    });
  }

  async close(): Promise<void> { this.redis.disconnect(); }
}
