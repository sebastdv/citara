import Redis from 'ioredis';
import type { DataSource } from 'typeorm';

const TIMEOUT_MS = 1500;

/** Corta lo que no contesta: un healthcheck colgado es peor que uno que dice "caído". */
const within = <T>(p: Promise<T>) => Promise.race([
  p, new Promise<never>((_, ko) => setTimeout(() => ko(new Error('timeout')), TIMEOUT_MS).unref()),
]);

/**
 * ¿Están Postgres y Redis? Lo usa el healthcheck de Docker y el despliegue,
 * que no da por buena una versión hasta que esto responda bien.
 */
export class HealthChecker {
  private readonly redis: Redis;

  constructor(private readonly ds: DataSource, redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: TIMEOUT_MS, lazyConnect: true });
    // Se reporta en cada chequeo; sin listener, un corte tumbaría el proceso.
    this.redis.on('error', () => {});
  }

  async check(): Promise<{ postgres: boolean; redis: boolean }> {
    const [postgres, redis] = await Promise.all([
      within(this.ds.query('SELECT 1')).then(() => true, () => false),
      within(this.redis.ping()).then((r) => r === 'PONG', () => false),
    ]);
    return { postgres, redis };
  }

  async close(): Promise<void> { this.redis.disconnect(); }
}
