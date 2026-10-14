import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadAudit } from '../../src/panel/audit-view';
import { createTestApp, resetDb, adminQuery, closeHelpers } from '../helpers';
import { seedBiz, seedConv } from './seed';
import { panelSession } from './session';

let app: INestApplication, ds: DataSource, s: Awaited<ReturnType<typeof panelSession>>;
const log = (t: string, action: string, over: { conversationId?: string; at?: string; details?: object } = {}) => adminQuery(
  `INSERT INTO audit_log (tenant_id, actor, action, conversation_id, details, created_at)
   VALUES ($1, 'system', $2, $3, $4, coalesce($5::timestamptz, clock_timestamp()))`,
  [t, action, over.conversationId ?? null, JSON.stringify(over.details ?? {}), over.at ?? null]);

beforeAll(async () => { app = await createTestApp(); ds = app.get(DataSource); });
beforeEach(async () => { await resetDb(); s = await panelSession(app); });
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('auditoría', () => {
  it('mezcla negocios del más reciente al más antiguo y pagina sin saltarse filas del mismo milisegundo', async () => {
    const a = await seedBiz('a', '1'), b = await seedBiz('b', '2');
    for (let i = 0; i < 60; i++) {
      await log(i % 2 ? a.tenantId : b.tenantId, 'control.to_human',
        { at: `2026-10-13T10:00:00.${String(999000 - i).padStart(6, '0')}Z` });
    }
    const p1 = await loadAudit(ds, {});
    expect(p1.rows).toHaveLength(50);
    const p2 = await loadAudit(ds, { before: p1.next! });
    expect(p2.rows).toHaveLength(10);
    expect(p2.next).toBeNull();
    const all = [...p1.rows, ...p2.rows].map((r) => r.cursorAt);
    expect(new Set(all).size).toBe(60);
    expect(all).toEqual([...all].sort().reverse());
  });
  it('filtra por negocio, prefijo de acción y conversación; el prefijo no admite comodines', async () => {
    const a = await seedBiz('a', '1'), b = await seedBiz('b', '2');
    const conv = await seedConv(b, '572');
    await log(b.tenantId, 'control.to_bot', { conversationId: conv });
    await log(a.tenantId, 'controlXto');
    await log(a.tenantId, 'agent.x');
    expect((await loadAudit(ds, { action: 'control.' })).rows.map((r) => r.action)).toEqual(['control.to_bot']);
    expect((await loadAudit(ds, { action: '%' })).rows).toEqual([]);
    expect((await loadAudit(ds, { action: 'control_' })).rows).toEqual([]);
    expect((await loadAudit(ds, { conversationId: conv })).rows).toHaveLength(1);
    const soloB = await loadAudit(ds, { slug: 'b' });
    expect(soloB.rows.map((r) => r.tenant.slug)).toEqual(['b']);
  });
  it('la pantalla escapa los details y enlaza la conversación', async () => {
    const a = await seedBiz('a', '1');
    const conv = await seedConv(a, '571');
    await log(a.tenantId, 'y', { conversationId: conv, details: { x: '<script>alert(1)</script>' } });
    const res = await s.get('/panel/auditoria').expect(200);
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toContain('<script>alert(1)');
    expect(res.text).toContain(`/panel/negocios/a/conversaciones/${conv}`);
  });
  it('la pantalla filtra por la conversación desde el enlace del chat', async () => {
    const a = await seedBiz('a', '1');
    const conv = await seedConv(a, '571');
    await log(a.tenantId, 'control.to_bot', { conversationId: conv });
    await log(a.tenantId, 'agent.budget_exhausted');
    const res = await s.get(`/panel/auditoria?negocio=a&conversacion=${conv}`).expect(200);
    expect(res.text).toContain('control.to_bot');
    expect(res.text).not.toContain('agent.budget_exhausted');
  });
});
