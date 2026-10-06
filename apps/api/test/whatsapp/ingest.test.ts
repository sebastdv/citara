import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { IngestService } from '../../src/whatsapp/ingest.service';
import type { InboundQueue } from '../../src/queues/inbound.queue';
import type { SyncQueue } from '../../src/queues/sync.queue';
import {
  accountUpdatePayload, contactsPayload, echoPayload, historyPayload, statusPayload,
} from './fixtures/coexistence';
import { resetDb, seedChannel, closeHelpers } from '../helpers';

let ds: DataSource;
let channels: ChannelResolver;
let calls: { method: string; job: any }[];
let failNextAdd: boolean;

const recorder = (methods: string[]) => Object.fromEntries(methods.map((method) => [
  method, async (job: unknown) => {
    if (failNextAdd) { failNextAdd = false; throw new Error('Redis caído'); }
    calls.push({ method, job });
  },
]));
const queue = recorder(['add', 'addEcho', 'addStatus', 'addAccountUpdate']) as unknown as InboundQueue;
const sync = recorder(['addHistory', 'addContacts']) as unknown as SyncQueue;
const ingest = () => new IngestService(ds, channels, queue, sync);

const payload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '102290', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001', phone_number_id: '106540' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
    messages: [{ from: '573001112233', id: 'wamid.ING1', timestamp: '1756900000',
                 type: 'text', text: { body: 'Hola' } }],
  } }] }],
};

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
  await enc.ready();
  channels = new ChannelResolver(ds, enc);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); await seedChannel(); calls = []; failNextAdd = false; });

describe('IngestService', () => {
  it('si encolar falla tras registrar el evento, la reentrega de Meta vuelve a encolar', async () => {
    failNextAdd = true;
    await expect(ingest().ingest(payload)).rejects.toThrow('Redis caído');
    const second = await ingest().ingest(payload);

    expect(calls.map((c) => c.job.message.wamid)).toEqual(['wamid.ING1']);
    expect(second.duplicates).toBe(1);
  });

  it('encola el eco del celular con su negocio y canal', async () => {
    await ingest().ingest(echoPayload({ wamid: 'wamid.E1', to: '573001112233' }));
    expect(calls).toEqual([{ method: 'addEcho', job: expect.objectContaining({
      tenantId: expect.any(String), channelId: expect.any(String),
      echo: expect.objectContaining({ wamid: 'wamid.E1' }) }) }]);
  });

  it('un eco reentregado se cuenta como duplicado pero se vuelve a encolar', async () => {
    const p = echoPayload({ wamid: 'wamid.E2', to: '573001112233' });
    await ingest().ingest(p);
    const second = await ingest().ingest(p);
    expect(second.duplicates).toBe(1);
    expect(calls.filter((c) => c.method === 'addEcho')).toHaveLength(2);
  });

  it('encola los estados en la cola de entrada', async () => {
    await ingest().ingest(statusPayload('wamid.OUT', 'read'));
    expect(calls[0]).toMatchObject({ method: 'addStatus', job: { status: { wamid: 'wamid.OUT', status: 'read' } } });
  });

  it('manda el historial y los contactos a la cola sync', async () => {
    await ingest().ingest(historyPayload({ customer: '573001112233',
      lines: [{ wamid: 'wamid.H', fromCustomer: true, text: 'x', at: new Date() }] }));
    await ingest().ingest(contactsPayload({ phone: '573001112233', name: 'Ana', action: 'add' }));
    expect(calls.map((c) => c.method)).toEqual(['addHistory', 'addContacts']);
  });

  it('encola el aviso de la cuenta sin resolver canal', async () => {
    await ingest().ingest(accountUpdatePayload('PARTNER_REMOVED'));
    expect(calls).toEqual([{ method: 'addAccountUpdate',
      job: { update: { wabaId: '102290', event: 'PARTNER_REMOVED', phoneNumber: '15550001' } } }]);
  });

  it('descarta en silencio el eco de un número que no es nuestro', async () => {
    await resetDb();
    await ingest().ingest(echoPayload({ wamid: 'wamid.E3', to: '573001112233' }));
    expect(calls).toEqual([]);
  });
});
