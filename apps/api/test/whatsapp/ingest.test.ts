import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { IngestService } from '../../src/whatsapp/ingest.service';
import type { InboundJob, InboundQueue } from '../../src/queues/inbound.queue';
import { resetDb, seedChannel, closeHelpers } from '../helpers';

let ds: DataSource;
let channels: ChannelResolver;
let added: InboundJob[];
let failNextAdd: boolean;

const queue = {
  async add(job: InboundJob) {
    if (failNextAdd) { failNextAdd = false; throw new Error('Redis caído'); }
    added.push(job);
  },
} as unknown as InboundQueue;

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
beforeEach(async () => { await resetDb(); await seedChannel(); added = []; failNextAdd = false; });

describe('IngestService', () => {
  it('si encolar falla tras registrar el evento, la reentrega de Meta vuelve a encolar', async () => {
    // El 500 hace que Meta reintente. El INSERT en webhook_events ya ocurrió,
    // así que la reentrega choca con la restricción: si eso bastara para
    // descartarla, el mensaje no se encolaría nunca.
    const ingest = new IngestService(ds, channels, queue);
    failNextAdd = true;

    await expect(ingest.ingest(payload)).rejects.toThrow('Redis caído');
    const second = await ingest.ingest(payload);

    expect(added.map((j) => j.message.wamid)).toEqual(['wamid.ING1']);
    expect(second.duplicates).toBe(1);
  });
});
