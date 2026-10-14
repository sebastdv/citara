import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource, EntityManager } from 'typeorm';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { BACKFILL_SQL } from '../../../../packages/db/src/migrations/1725800200000-AddLastMessageAtToConversations';
import { resetDb, seedChannel, seedContact, adminQuery, closeHelpers } from '../helpers';

let app: DataSource, tenantId: string, channelId: string, conversationId: string;
const insertMsg = (m: EntityManager, at: string, origin = 'customer') => m.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, occurred_at)
   VALUES ($1, $2, 'in', $3, 'text', 'hola', $4)`, [tenantId, conversationId, origin, at]);

beforeEach(async () => {
  await resetDb();
  app ??= await createDataSource(process.env.DATABASE_URL!).initialize();
  ({ tenantId, channelId } = await seedChannel());
  const contactId = await seedContact(tenantId);
  [{ id: conversationId }] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, contactId, channelId]);
});
afterAll(async () => { await app?.destroy(); await closeHelpers(); });

const lastAt = async (): Promise<Date | null> =>
  (await adminQuery(`SELECT last_message_at FROM conversations WHERE id = $1`, [conversationId]))[0].last_message_at;

describe('last_message_at', () => {
  it('nace NULL y avanza con cada mensaje insertado por la app', async () => {
    expect(await lastAt()).toBeNull();
    await runInTenant(app, tenantId, (m) => insertMsg(m, '2026-10-13T15:00:00Z'));
    expect((await lastAt())!.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });

  it('un mensaje viejo del historial no la mueve', async () => {
    await runInTenant(app, tenantId, (m) => insertMsg(m, '2026-10-13T15:00:00Z'));
    await runInTenant(app, tenantId, (m) => insertMsg(m, '2026-05-01T10:00:00Z', 'history'));
    expect((await lastAt())!.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });

  it('el relleno de la migración toma el mensaje más reciente de cada conversación', async () => {
    await runInTenant(app, tenantId, (m) => insertMsg(m, '2026-10-01T08:00:00Z'));
    await runInTenant(app, tenantId, (m) => insertMsg(m, '2026-09-01T08:00:00Z'));
    await adminQuery(`UPDATE conversations SET last_message_at = NULL`);
    await adminQuery(BACKFILL_SQL);
    expect((await lastAt())!.toISOString()).toBe('2026-10-01T08:00:00.000Z');
  });

  it('la función del trigger fija search_path y no es SECURITY DEFINER', async () => {
    const [f] = await adminQuery(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'touch_conversation_last_message'`);
    expect(f.prosecdef).toBe(false);
    expect(f.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
  });

  it('dos transacciones que insertan en la misma conversación terminan las dos', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t1 = runInTenant(app, tenantId, async (m) => { await insertMsg(m, '2026-10-13T15:00:00Z'); await gate; });
    await new Promise((r) => setTimeout(r, 50));
    const t2 = runInTenant(app, tenantId, (m) => insertMsg(m, '2026-10-13T15:01:00Z'));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([t1, t2]);
    expect((await lastAt())!.toISOString()).toBe('2026-10-13T15:01:00.000Z');
  });
});
