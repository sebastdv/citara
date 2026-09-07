import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, seedChannel } from '../helpers';

const SECRET = process.env.META_APP_SECRET!;
let app: INestApplication;

const sign = (body: object) =>
  'sha256=' + createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

const inbound = (wamid: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: wamid, timestamp: '1756900000',
                 type: 'text', text: { body: 'Hola' } }],
  } }] }],
});

beforeAll(async () => { await resetDb(); await seedChannel(); app = await createTestApp(); });
afterAll(async () => { await app.close(); });

describe('GET /webhooks/whatsapp', () => {
  it('devuelve el challenge cuando el verify_token coincide', async () => {
    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe',
               'hub.verify_token': process.env.META_VERIFY_TOKEN,
               'hub.challenge': '123456' })
      .expect(200).expect('123456');
  });

  it('devuelve 403 cuando el verify_token no coincide', async () => {
    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': '1' })
      .expect(403);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('rechaza con 401 si la firma es inválida', async () => {
    const body = inbound('wamid.SIGN');
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(body).expect(401);
  });

  it('acepta un mensaje firmado y lo encola', async () => {
    const body = inbound('wamid.OK1');
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body))
      .send(body).expect(200);
    expect(res.body).toEqual({ enqueued: 1, duplicates: 0 });
  });

  it('deduplica: el mismo wamid reenviado no se encola dos veces', async () => {
    const body = inbound('wamid.DUP');
    const sig = sign(body);
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sig).send(body).expect(200);
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sig).send(body).expect(200);
    expect(res.body).toEqual({ enqueued: 0, duplicates: 1 });
  });

  it('responde 200 aunque el phone_number_id sea desconocido', async () => {
    const body = inbound('wamid.UNK');
    body.entry[0].changes[0].value.metadata.phone_number_id = '999999';
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sign(body)).send(body).expect(200);
  });

  it('descarta en silencio un mensaje sin wamid, en vez de contarlo como duplicado', async () => {
    // Meta no siempre manda `id` (p.ej. algunos eventos de sistema). El
    // normalizador produce wamid: '' para esos casos, y la columna es
    // varchar(128) NOT NULL UNIQUE: si se insertara, el PRIMER mensaje sin
    // wamid entraría y todos los siguientes chocarían contra esa fila y se
    // contarían como "duplicados" — perdiéndose en silencio. Debe descartarse
    // antes del INSERT, y no contar ni como encolado ni como duplicado.
    const body = inbound('');
    delete (body.entry[0].changes[0].value.messages[0] as { id?: string }).id;
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sign(body)).send(body).expect(200);
    expect(res.body).toEqual({ enqueued: 0, duplicates: 0 });
  });

  it('responde en menos de 100 ms', async () => {
    const body = inbound('wamid.FAST');
    const t0 = Date.now();
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp').set('x-hub-signature-256', sign(body)).send(body).expect(200);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
