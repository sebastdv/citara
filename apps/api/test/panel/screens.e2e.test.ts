import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, adminQuery, closeHelpers } from '../helpers';
import { seedBiz, seedConv, msg } from './seed';
import { panelSession } from './session';

let app: INestApplication, s: Awaited<ReturnType<typeof panelSession>>;
const FUTURE = '2099-01-01T00:00:00Z';

beforeAll(async () => { app = await createTestApp(); });
beforeEach(async () => { await resetDb(); s = await panelSession(app); });
afterAll(async () => { await app.close(); await closeHelpers(); });

describe('bandeja', () => {
  it('lista el traspaso y escapa lo que escribió el cliente', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571', { control: 'human', until: FUTURE, reason: 'flow_handoff' });
    await adminQuery(`UPDATE contacts SET name = '<img src=x onerror=alert(1)>'`);
    await msg(a.tenantId, c, new Date().toISOString(), { body: '"><script>alert(2)</script>' });
    const res = await s.get('/panel').expect(200);
    expect(res.text).toContain(`/panel/negocios/a/conversaciones/${c}`);
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).toContain('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(res.text).not.toContain('<script>alert(2)');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('el flujo pidió un humano');
    expect(res.text).toContain('data-refresh="15000"');
  });
  it('el fragmento trae solo la lista, con las cabeceras de seguridad y escapada', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571', { control: 'human', until: FUTURE, reason: 'phone' });
    await msg(a.tenantId, c, new Date().toISOString(), { body: '<b>x</b>' });
    const res = await s.get('/panel').set('X-Fragment', 'lista').expect(200);
    expect(res.text).not.toContain('<html');
    expect(res.text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
  it('la pestaña todas pagina con un enlace a las más antiguas', async () => {
    const a = await seedBiz('a', '1');
    for (let i = 0; i < 51; i++) {
      const c = await seedConv(a, `57${i}`);
      await msg(a.tenantId, c, new Date(Date.UTC(2026, 9, 13, 10, i)).toISOString());
    }
    const res = await s.get('/panel?tab=todas').expect(200);
    const next = /href="(\/panel\?[^"]*antes=[^"]+)"/.exec(res.text)![1].replace(/&amp;/g, '&');
    const p2 = await s.get(next).expect(200);
    expect((p2.text.match(/\/conversaciones\//g) ?? []).length).toBe(1);
  });
});

describe('chat', () => {
  it('muestra control, ventana y mensajes con su origen y estado', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571', { control: 'human', until: FUTURE, reason: 'phone',
                                         lastInboundAt: new Date(Date.now() - 3600_000).toISOString() });
    await msg(a.tenantId, c, new Date().toISOString(), { direction: 'out', origin: 'phone', body: 'ya voy' });
    await msg(a.tenantId, c, new Date().toISOString(), { direction: 'out', origin: 'bot', status: 'superseded',
      body: 'te agendo', payload: { kind: 'text', body: 'te agendo' } });
    const res = await s.get(`/panel/negocios/a/conversaciones/${c}`).expect(200);
    expect(res.text).toContain('Dueño (celular)');
    expect(res.text).toContain('descartado');
    expect(res.text).toContain('Ventana abierta hasta');
    expect(res.text).toContain('el dueño escribió desde su celular');
    expect(res.text).toMatch(/<textarea name="texto"[^>]*>/);
    expect(res.text).not.toMatch(/<textarea[^>]*disabled/);
    expect(res.text).toContain('data-refresh="5000"');
    expect(res.text).toContain('/tomar');
  });
  it('el fragmento de mensajes trae solo la lista', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571');
    await msg(a.tenantId, c, new Date().toISOString(), { body: 'hola <i>' });
    const res = await s.get(`/panel/negocios/a/conversaciones/${c}`).set('X-Fragment', 'mensajes').expect(200);
    expect(res.text).not.toContain('<html');
    expect(res.text).toContain('hola &lt;i&gt;');
  });
  it('con la ventana cerrada el campo se deshabilita con la razón', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571', { lastInboundAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    const res = await s.get(`/panel/negocios/a/conversaciones/${c}`).expect(200);
    expect(res.text).toMatch(/<textarea[^>]*disabled/);
    expect(res.text).toContain('pasaron más de 24 h');
  });
  it('con el negocio suspendido o el canal desconectado también', async () => {
    const a = await seedBiz('a', '1');
    const c = await seedConv(a, '571');
    await adminQuery(`UPDATE whatsapp_channels SET status = 'disconnected'`);
    let res = await s.get(`/panel/negocios/a/conversaciones/${c}`).expect(200);
    expect(res.text).toContain('canal de WhatsApp está desconectado');
    await adminQuery(`UPDATE whatsapp_channels SET status = 'active'; UPDATE tenants SET status = 'suspended'`);
    res = await s.get(`/panel/negocios/a/conversaciones/${c}`).expect(200);
    expect(res.text).toContain('negocio no está activo');
    expect(res.text).toMatch(/<textarea[^>]*disabled/);
  });
  it('una conversación de otro negocio, un slug inexistente o un id inválido dan 404', async () => {
    await seedBiz('a', '1');
    const b = await seedBiz('b', '2');
    const cb = await seedConv(b, '572');
    await s.get(`/panel/negocios/a/conversaciones/${cb}`).expect(404);
    await s.get(`/panel/negocios/zz/conversaciones/${cb}`).expect(404);
    await s.get(`/panel/negocios/a/conversaciones/no-es-uuid`).expect(404);
    await s.get(`/panel/negocios/b/conversaciones/${cb}`).expect(200);
  });
});
