import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { acquireLease, releaseLease, renewLease } from '../../src/agent/agent.processor';
import { resetDb, seedChannel, seedContact, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, conversationId: string;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const lease = async () => (await adminQuery(
  `SELECT agent_lease_owner AS owner, agent_lease_until > now() + interval '100 seconds' AS largo FROM conversations`))[0];

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  const contactId = await seedContact(tenantId);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [tenantId, contactId, channelId]);
  conversationId = c.id;
});

describe('lease del agente por conversación', () => {
  it('un solo dueño a la vez', async () => {
    expect(await acquireLease(app, tenantId, conversationId, A)).toBe(true);
    expect(await acquireLease(app, tenantId, conversationId, B)).toBe(false);
    expect((await lease()).owner).toBe(A);
  });

  it('quien perdió el lease no puede liberar el de otro', async () => {
    await acquireLease(app, tenantId, conversationId, A);
    // A se demoró: su lease venció y B lo tomó.
    await adminQuery(`UPDATE conversations SET agent_lease_until = now() - interval '1 second'`);
    expect(await acquireLease(app, tenantId, conversationId, B)).toBe(true);
    await releaseLease(app, tenantId, conversationId, A);
    expect((await lease()).owner).toBe(B);
    await releaseLease(app, tenantId, conversationId, B);
    expect((await lease()).owner).toBeNull();
  });

  it('el dueño lo renueva mientras trabaja; otro no', async () => {
    await acquireLease(app, tenantId, conversationId, A, 5);
    expect(await renewLease(app, tenantId, conversationId, B, 120)).toBe(false);
    expect((await lease()).largo).toBe(false);
    expect(await renewLease(app, tenantId, conversationId, A, 120)).toBe(true);
    expect((await lease()).largo).toBe(true);
  });
});
