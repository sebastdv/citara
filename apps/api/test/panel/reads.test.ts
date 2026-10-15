import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDataSource } from '@citara/db';
import type { DataSource } from 'typeorm';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { loadInbox } from '../../src/panel/inbox';
import { loadConversation, describeMessage } from '../../src/panel/conversation';
import { panelTenants, tenantBySlug } from '../../src/panel/tenants';
import { resetDb, adminQuery, closeHelpers } from '../helpers';
import { seedBiz, seedConv, msg } from './seed';

let app: DataSource;
const NOW = new Date('2026-10-13T15:00:00Z');
const LATER = '2026-10-13T20:00:00Z';

beforeEach(async () => {
  await resetDb();
  app ??= await createDataSource(process.env.DATABASE_URL!).initialize();
});
afterAll(async () => { await app?.destroy(); await closeHelpers(); });

describe('bandeja', () => {
  it('traspasos abiertos de todos los negocios; primero cloud_api con el cliente esperando', async () => {
    const a = await seedBiz('a', '1', 'coexistence'), b = await seedBiz('b', '2', 'cloud_api');
    const ca = await seedConv(a, '571', { control: 'human', until: LATER, reason: 'phone' });
    const cb = await seedConv(b, '572', { control: 'human', until: LATER, reason: 'flow_handoff' });
    const vencida = await seedConv(b, '573', { control: 'human', until: '2026-10-13T10:00:00Z', reason: 'operator' });
    const bot = await seedConv(b, '574');
    await msg(a.tenantId, ca, '2026-10-13T14:59:00Z');
    await msg(b.tenantId, cb, '2026-10-13T14:00:00Z');
    await msg(b.tenantId, vencida, '2026-10-13T14:58:00Z');
    await msg(b.tenantId, bot, '2026-10-13T14:58:00Z');
    const { rows, next } = await loadInbox(app, { tab: 'traspasos' }, NOW);
    expect(rows.map((r) => [r.tenant.slug, r.conversationId])).toEqual([['b', cb], ['a', ca]]);
    expect(rows[0]).toMatchObject({ mode: 'cloud_api', reason: 'flow_handoff', lastDirection: 'in', lastPreview: 'hola' });
    expect(next).toBeNull();
  });
  it('un cloud_api que ya respondió no se adelanta a los demás', async () => {
    const b = await seedBiz('b', '2', 'cloud_api');
    const respondida = await seedConv(b, '571', { control: 'human', until: LATER, reason: 'operator' });
    const reciente = await seedConv(b, '572', { control: 'human', until: LATER, reason: 'phone' });
    await msg(b.tenantId, respondida, '2026-10-13T14:00:00Z', { direction: 'out', origin: 'operator', status: 'sent' });
    await msg(b.tenantId, reciente, '2026-10-13T14:30:00Z', { direction: 'out', origin: 'phone' });
    const { rows } = await loadInbox(app, { tab: 'traspasos' }, NOW);
    expect(rows.map((r) => r.conversationId)).toEqual([reciente, respondida]);
  });
  it('todas: paginada por última actividad, filtrable por negocio', async () => {
    const a = await seedBiz('a', '1'), b = await seedBiz('b', '2');
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const biz = i % 2 ? a : b;
      const c = await seedConv(biz, `57${i}`);
      await msg(biz.tenantId, c, new Date(Date.UTC(2026, 9, 13, 10, i)).toISOString());
      ids.unshift(c);
    }
    await seedConv(a, '5799');   // sin mensajes: no aparece
    const p1 = await loadInbox(app, { tab: 'todas' }, NOW);
    expect(p1.rows.map((r) => r.conversationId)).toEqual(ids.slice(0, 50));
    const p2 = await loadInbox(app, { tab: 'todas', before: p1.next! }, NOW);
    expect(p2.rows.map((r) => r.conversationId)).toEqual(ids.slice(50));
    expect(p2.next).toBeNull();
    const soloA = await loadInbox(app, { tab: 'todas', slug: 'a' }, NOW);
    expect(soloA.rows).toHaveLength(30);
    expect(soloA.rows.every((r) => r.tenant.slug === 'a')).toBe(true);
  });
  it('el corte de página no se salta conversaciones del mismo milisegundo (microsegundos)', async () => {
    const a = await seedBiz('a', '1');
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const c = await seedConv(a, `57${i}`);
      await msg(a.tenantId, c, '2026-10-13T10:00:00Z');
      ids.push(c);
    }
    // Todas en el mismo milisegundo, distintas en microsegundos: la 0 es la más reciente.
    for (const [i, id] of ids.entries()) {
      await adminQuery(`UPDATE conversations SET last_message_at = '2026-10-13T10:00:00.123900Z'::timestamptz - make_interval(secs => $2 * 0.000001) WHERE id = $1`, [id, i]);
    }
    const p1 = await loadInbox(app, { tab: 'todas' }, NOW);
    const p2 = await loadInbox(app, { tab: 'todas', before: p1.next! }, NOW);
    expect([...p1.rows, ...p2.rows].map((r) => r.conversationId)).toEqual(ids);
  });
  it('saved_name gana al nombre de perfil', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571', { control: 'human', until: LATER, reason: 'phone' });
    await adminQuery(`UPDATE contacts SET saved_name = 'Ana (clienta)'`);
    await msg(a.tenantId, c, '2026-10-13T14:00:00Z');
    expect((await loadInbox(app, { tab: 'traspasos' }, NOW)).rows[0].contactName).toBe('Ana (clienta)');
  });
});

describe('chat', () => {
  it('solo se ve dentro del negocio dueño: con otro contexto no existe', async () => {
    const a = await seedBiz('a', '1'), b = await seedBiz('b', '2');
    const ca = await seedConv(a, '571');
    expect(await runInTenant(app, b.tenantId, (m) => loadConversation(m, ca))).toBeNull();
    expect(await runInTenant(app, a.tenantId, (m) => loadConversation(m, ca))).toMatchObject({ waId: '571', mode: 'cloud_api' });
  });
  it('mensajes en orden real con origen y estado; detecta operador pendiente', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571');
    await msg(a.tenantId, c, '2026-10-13T14:01:00Z', { direction: 'out', origin: 'operator', status: 'pending',
      body: 'ya te ayudo', payload: { kind: 'text', body: 'ya te ayudo' } });
    await msg(a.tenantId, c, '2026-10-13T14:00:00Z');
    await adminQuery(`UPDATE messages SET created_at = now() - interval '1 minute'`);
    const v = (await runInTenant(app, a.tenantId, (m) => loadConversation(m, c)))!;
    expect(v.messages.map((x) => [x.origin, x.status, x.text])).toEqual([
      ['customer', null, 'hola'], ['operator', 'pending', 'ya te ayudo']]);
    expect(v.hasPendingOperator).toBe(true);
  });
  it('un mensaje del operador recién enviado no cuenta como atascado: pending es también "va saliendo"', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571');
    await msg(a.tenantId, c, new Date().toISOString(), { direction: 'out', origin: 'operator', status: 'pending',
      payload: { kind: 'text', body: 'recién' } });
    expect((await runInTenant(app, a.tenantId, (m) => loadConversation(m, c)))!.hasPendingOperator).toBe(false);
    await adminQuery(`UPDATE messages SET created_at = now() - interval '31 seconds'`);
    expect((await runInTenant(app, a.tenantId, (m) => loadConversation(m, c)))!.hasPendingOperator).toBe(true);
  });
  it('muestra solo los últimos 200 mensajes, en orden', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571');
    for (let i = 0; i < 205; i++) await msg(a.tenantId, c, new Date(Date.UTC(2026, 9, 13, 0, 0, i)).toISOString(), { body: `m${i}` });
    const v = (await runInTenant(app, a.tenantId, (m) => loadConversation(m, c)))!;
    expect(v.messages).toHaveLength(200);
    expect([v.messages[0].text, v.messages[199].text]).toEqual(['m5', 'm204']);
  });
  it('tenantBySlug resuelve y panelTenants lista ordenado', async () => {
    await seedBiz('b', '2'); await seedBiz('a', '1');
    expect((await panelTenants(app)).map((t) => t.slug)).toEqual(['a', 'b']);
    expect(await tenantBySlug(app, 'zz')).toBeNull();
    expect(await tenantBySlug(app, 'a')).toMatchObject({ slug: 'a', timezone: 'America/Bogota' });
  });
});

describe('describeMessage', () => {
  it('muestra botones, listas, plantillas y adjuntos como texto', () => {
    expect(describeMessage({ direction: 'out', type: 'interactive', body: '¿Qué día?', payload: { kind: 'buttons', body: '¿Qué día?',
      buttons: [{ id: '1', title: 'Lunes' }, { id: '2', title: 'Martes' }] } })).toBe('¿Qué día?\n[Lunes] [Martes]');
    expect(describeMessage({ direction: 'out', type: 'interactive', body: 'Elige', payload: { kind: 'list', body: 'Elige', button: 'Ver',
      sections: [{ title: 'S', rows: [{ id: 'a', title: 'Corte' }] }] } })).toBe('Elige\n[Corte]');
    expect(describeMessage({ direction: 'out', type: 'template', body: null,
      payload: { kind: 'template', name: 'recordatorio', language: 'es', params: [] } })).toBe('Plantilla «recordatorio»');
    expect(describeMessage({ direction: 'out', type: 'template', body: 'Recordatorio de 2 h: Ana · hoy 3:00 p. m. · Corte',
      payload: { kind: 'template', name: 'recordatorio', language: 'es', params: [] } })).toBe('Recordatorio de 2 h: Ana · hoy 3:00 p. m. · Corte');
    expect(describeMessage({ direction: 'in', type: 'image', body: null, payload: {} })).toBe('[image]');
    expect(describeMessage({ direction: 'in', type: 'text', body: 'hola', payload: { kind: 'buttons' } })).toBe('hola');
  });
});
