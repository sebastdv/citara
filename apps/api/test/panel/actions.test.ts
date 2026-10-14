import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDataSource } from '@citara/db';
import type { DataSource, EntityManager } from 'typeorm';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { takeControl, returnControl, sendOperatorMessage, pendingOperatorJobs } from '../../src/panel/actions';
import { resetDb, seedOperator, adminQuery, closeHelpers } from '../helpers';
import { seedBiz, seedConv, msg } from './seed';

let app: DataSource, a: Awaited<ReturnType<typeof seedBiz>>, c: string, operatorId: string;
beforeEach(async () => {
  await resetDb();
  app ??= await createDataSource(process.env.DATABASE_URL!).initialize();
  a = await seedBiz('a', '1');
  c = await seedConv(a, '571');
  operatorId = await seedOperator();
});
afterAll(async () => { await app?.destroy(); await closeHelpers(); });

const inA = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, a.tenantId, fn);
const send = (text = 'hola', submissionId = randomUUID()) => inA((m) => sendOperatorMessage(m, {
  tenantId: a.tenantId, conversationId: c, operatorId, text, submissionId, now: new Date() }));
const actions = async () => (await adminQuery(`SELECT action FROM audit_log ORDER BY created_at`)).map((r: { action: string }) => r.action);

describe('acciones del operador', () => {
  it('tomar da el control al operador por las horas del negocio y lo audita con su id', async () => {
    await inA((m) => takeControl(m, { tenantId: a.tenantId, conversationId: c, operatorId, now: new Date() }));
    const [conv] = await adminQuery(
      `SELECT control, control_reason, human_until > now() + interval '11 hours' AS long FROM conversations`);
    expect(conv).toEqual({ control: 'human', control_reason: 'operator', long: true });
    expect(await adminQuery(`SELECT actor, action, conversation_id FROM audit_log`))
      .toEqual([{ actor: `operator:${operatorId}`, action: 'control.to_human', conversation_id: c }]);
  });
  it('tomar lo que tenía el dueño lo pasa al operador, conserva el plazo y lo audita', async () => {
    await adminQuery(`UPDATE conversations SET control = 'human', control_reason = 'phone', human_until = now() + interval '20 hours'`);
    await inA((m) => takeControl(m, { tenantId: a.tenantId, conversationId: c, operatorId, now: new Date() }));
    const [conv] = await adminQuery(`SELECT control_reason, human_until > now() + interval '19 hours' AS kept FROM conversations`);
    expect(conv).toEqual({ control_reason: 'operator', kept: true });
    expect(await adminQuery(`SELECT action, details FROM audit_log`))
      .toEqual([{ action: 'control.to_operator', details: { from: 'phone' } }]);
  });
  it('tomar dos veces no audita de más', async () => {
    for (let i = 0; i < 2; i++) await inA((m) => takeControl(m, { tenantId: a.tenantId, conversationId: c, operatorId, now: new Date() }));
    expect(await actions()).toEqual(['control.to_human']);
  });
  it('devolver deja al bot, cierra la sesión del flujo y lo audita', async () => {
    await adminQuery(`UPDATE conversations SET control = 'human', control_reason = 'operator', human_until = now() + interval '1 hour'`);
    await inA((m) => returnControl(m, { tenantId: a.tenantId, conversationId: c, operatorId }));
    expect((await adminQuery(`SELECT control FROM conversations`))[0].control).toBe('bot');
    expect(await adminQuery(`SELECT actor, action, details FROM audit_log`))
      .toEqual([{ actor: `operator:${operatorId}`, action: 'control.to_bot', details: { cause: 'operator' } }]);
  });
  it('responder crea la fila operator pending, toma el control y audita; el mismo envío no duplica', async () => {
    const sub = randomUUID();
    const first = await send('  Hola, ya te ayudo  ', sub);
    const second = await send('  Hola, ya te ayudo  ', sub);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(await adminQuery(`SELECT origin, status, direction, body, payload->>'kind' AS kind, reply_to_id FROM messages`))
      .toEqual([{ origin: 'operator', status: 'pending', direction: 'out', body: 'Hola, ya te ayudo', kind: 'text', reply_to_id: null }]);
    const [row] = await adminQuery(`SELECT id FROM messages`);
    expect(first.job).toEqual({ tenantId: a.tenantId, channelId: a.channelId, conversationId: c, to: '571', messageId: row.id });
    expect((await adminQuery(`SELECT control_reason FROM conversations`))[0].control_reason).toBe('operator');
    expect(await actions()).toEqual(['control.to_human', 'message.operator_sent']);
  });
  it('responder exige texto, ventana, canal y negocio activos, sin dejar rastro al rechazar', async () => {
    await expect(send('   ')).rejects.toMatchObject({ code: 'texto' });
    await expect(send('x'.repeat(4097))).rejects.toMatchObject({ code: 'texto' });
    await adminQuery(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours'`);
    await expect(send()).rejects.toMatchObject({ code: 'ventana' });
    await adminQuery(`UPDATE conversations SET last_inbound_at = NULL`);
    await expect(send()).rejects.toMatchObject({ code: 'ventana' });
    await adminQuery(`UPDATE conversations SET last_inbound_at = now()`);
    await adminQuery(`UPDATE whatsapp_channels SET status = 'disconnected'`);
    await expect(send()).rejects.toMatchObject({ code: 'canal' });
    await adminQuery(`UPDATE whatsapp_channels SET status = 'active'`);
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    await expect(send()).rejects.toMatchObject({ code: 'negocio' });
    expect(await adminQuery(`SELECT * FROM messages`)).toEqual([]);
    expect(await adminQuery(`SELECT * FROM audit_log`)).toEqual([]);
    expect((await adminQuery(`SELECT control FROM conversations`))[0].control).toBe('bot');
  });
  it('una conversación de otro negocio no existe para ninguna acción', async () => {
    const b = await seedBiz('b', '2');
    const all = [
      (m: EntityManager) => takeControl(m, { tenantId: b.tenantId, conversationId: c, operatorId, now: new Date() }),
      (m: EntityManager) => returnControl(m, { tenantId: b.tenantId, conversationId: c, operatorId }),
      (m: EntityManager) => sendOperatorMessage(m, { tenantId: b.tenantId, conversationId: c, operatorId, text: 'x',
                                                     submissionId: randomUUID(), now: new Date() }),
    ];
    for (const act of all) await expect(runInTenant(app, b.tenantId, act)).rejects.toMatchObject({ code: 'no_encontrada' });
    expect(await adminQuery(`SELECT * FROM audit_log`)).toEqual([]);
    expect(await adminQuery(`SELECT * FROM messages`)).toEqual([]);
  });
  it('pendingOperatorJobs devuelve solo las filas del operador en pending', async () => {
    const now = new Date().toISOString();
    const [p] = await msg(a.tenantId, c, now, { direction: 'out', origin: 'operator', status: 'pending', payload: { kind: 'text', body: 'a' } });
    await msg(a.tenantId, c, now, { direction: 'out', origin: 'operator', status: 'unconfirmed', payload: { kind: 'text', body: 'b' } });
    await msg(a.tenantId, c, now, { direction: 'out', origin: 'bot', status: 'pending', payload: { kind: 'text', body: 'c' } });
    expect(await inA((m) => pendingOperatorJobs(m, { tenantId: a.tenantId, conversationId: c })))
      .toEqual([{ tenantId: a.tenantId, channelId: a.channelId, conversationId: c, to: '571', messageId: p.id }]);
  });
});
