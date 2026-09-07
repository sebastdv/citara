import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, seedChannel } from '../helpers';
import { IngestService } from '../../src/whatsapp/ingest.service';

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

/**
 * El test de deduplicación del plan es secuencial: manda un webhook, espera la
 * respuesta, manda el segundo. Meta, en cambio, reintenta cuando no recibe el
 * 200 a tiempo, y esos reintentos pueden llegar solapados.
 *
 * ALCANCE REAL DE ESTE TEST, para que nadie lo confunda con lo que no es:
 * ejercita el camino concurrente y detectaría una rotura gruesa de la
 * deduplicación, pero NO es un detector de la condición de carrera. Se comprobó
 * sustituyendo el `ON CONFLICT` por el antipatrón `SELECT` y luego `INSERT`, y
 * el test siguió pasando: con el bucle de eventos de Node y el pool, las ocho
 * llamadas se serializan lo suficiente como para que la primera inserción
 * termine antes de que las demás consulten.
 *
 * Quien confíe en que esto blinda la idempotencia se va a llevar una sorpresa.
 * Lo que blinda la idempotencia es el índice único sobre `wamid` más
 * `ON CONFLICT DO NOTHING`, que resuelve Postgres de forma atómica; eso es una
 * garantía del motor, no algo que este test demuestre.
 */
describe('POST /webhooks/whatsapp bajo entrega concurrente', () => {
  it('encola una sola vez aunque el mismo wamid llegue en paralelo', async () => {
    // Se ataca `IngestService` y no el endpoint HTTP a propósito: supertest
    // abre un puerto efímero por petición sobre el mismo servidor, y ocho en
    // paralelo se pisan con ECONNRESET. Eso es un artefacto del cliente de
    // pruebas, no del sistema. La garantía que importa —el índice único más
    // ON CONFLICT resolviéndose de forma atómica— vive en el servicio, así que
    // es ahí donde tiene sentido medirla.
    const ingest = app.get(IngestService);
    const payload = inbound('wamid.RACE');

    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => ingest.ingest(payload)),
    );

    const encolados = resultados.reduce((n, r) => n + r.enqueued, 0);
    const duplicados = resultados.reduce((n, r) => n + r.duplicates, 0);

    expect(encolados).toBe(1);
    expect(duplicados).toBe(7);
  });
});
