import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { CalendarQueue } from '../../src/queues/calendar.queue';
import { hashToken } from '../../src/onboarding/links';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

const CANAL = '6f1c1d1e-0b7a-4f0e-9a51-1b2c3d4e5f60';
let app: INestApplication;
let tenantId: string, accountId: string;
const queue = { add: vi.fn(), schedule: vi.fn(), onModuleDestroy: vi.fn() };
const notify = (headers: Record<string, string>) =>
  request(app.getHttpServer()).post('/webhooks/google').set(headers).send().expect(200);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CalendarQueue).useValue(queue).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
});
afterAll(async () => { await app.close(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId } = await seedChannel());
  const { resourceId } = await seedCatalog(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  await adminQuery(`UPDATE google_accounts SET watch_channel_id = $1, watch_token_hash = $2`, [CANAL, hashToken('SECRETO')]);
  queue.add.mockClear();
});

describe('POST /webhooks/google', () => {
  it('un aviso de cambios de un canal propio encola la lectura de esa cuenta', async () => {
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': `${tenantId}.SECRETO`, 'X-Goog-Resource-State': 'exists' });
    expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'pull', data: { tenantId, accountId } }));
  });

  it('el aviso inicial "sync" no tiene cambios que leer', async () => {
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': `${tenantId}.SECRETO`, 'X-Goog-Resource-State': 'sync' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('un token equivocado, un canal ajeno o basura responden 200 sin encolar nada', async () => {
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': `${tenantId}.OTRO`, 'X-Goog-Resource-State': 'exists' });
    await notify({ 'X-Goog-Channel-ID': CANAL, 'X-Goog-Channel-Token': 'no-es-un-uuid.SECRETO', 'X-Goog-Resource-State': 'exists' });
    await notify({});
    expect(queue.add).not.toHaveBeenCalled();
  });
});
