import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { ContactsSyncProcessor } from '../../src/coexistence/contacts-sync.processor';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let ds: DataSource;
let processor: ContactsSyncProcessor;
let tenantId: string;

const contact = (action: 'add' | 'remove', name = 'Ana Pérez') => ({
  phoneNumberId: '106540', wabaId: '102290', waId: '573001112233', name, action });

beforeAll(async () => {
  ds = createDataSource(process.env.DATABASE_URL!);
  await ds.initialize();
  processor = new ContactsSyncProcessor(ds);
});
afterAll(async () => { await ds.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('ContactsSyncProcessor', () => {
  it('guarda el nombre con que el negocio tiene al cliente, aunque aún no haya escrito', async () => {
    await processor.process({ tenantId, contacts: [contact('add')] });
    expect(await adminQuery(`SELECT wa_id, saved_name FROM contacts`))
      .toEqual([{ wa_id: '573001112233', saved_name: 'Ana Pérez' }]);
  });

  it('actualiza el nombre si el negocio lo cambia y lo borra si quita el contacto', async () => {
    await processor.process({ tenantId, contacts: [contact('add')] });
    await processor.process({ tenantId, contacts: [contact('add', 'Ana P. (martes)')] });
    expect((await adminQuery(`SELECT saved_name FROM contacts`))[0].saved_name).toBe('Ana P. (martes)');

    await processor.process({ tenantId, contacts: [contact('remove')] });
    expect((await adminQuery(`SELECT saved_name FROM contacts`))[0].saved_name).toBeNull();
  });
});
