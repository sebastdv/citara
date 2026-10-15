import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createDataSource } from '@citara/db';
import { HealthChecker } from '../../src/health/health';
import { createTestApp, closeHelpers } from '../helpers';

let app: INestApplication;
beforeAll(async () => { app = await createTestApp(); });
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('/healthz', () => {
  it('responde 200 con Postgres y Redis arriba, sin cabeceras de caché', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok', postgres: true, redis: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('el chequeo marca caído lo que no responde, sin colgarse', async () => {
    const live = createDataSource(process.env.DATABASE_URL!);
    await live.initialize();
    const deadRedis = new HealthChecker(live, 'redis://127.0.0.1:1');
    expect(await deadRedis.check()).toEqual({ postgres: true, redis: false });
    await deadRedis.close();
    await live.destroy();

    const deadPg = createDataSource('postgres://citara_app:x@127.0.0.1:1/citara');   // sin inicializar
    const noPg = new HealthChecker(deadPg, process.env.REDIS_URL!);
    const started = Date.now();
    expect(await noPg.check()).toEqual({ postgres: false, redis: true });
    expect(Date.now() - started).toBeLessThan(3000);
    await noPg.close();
  });
});
