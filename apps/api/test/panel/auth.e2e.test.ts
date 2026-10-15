import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { LoginLimiter } from '../../src/panel/login-limiter';
import { dummyHashStarted } from '../../src/panel/password';
import { PanelGuard } from '../../src/panel/panel-auth';
import { PANEL_CONTROLLERS } from '../../src/panel/panel.controller';
import { AppModule } from '../../src/app.module';
import { createTestApp, resetDb, seedOperator, adminQuery, closeHelpers } from '../helpers';

let app: INestApplication;
const limiter = new LoginLimiter(process.env.REDIS_URL!);
const http = () => request(app.getHttpServer());
const login = (email = 'op@citara.co', password = 'clave-de-prueba-123', next = '/panel/costos') =>
  http().post('/panel/login').type('form').send({ email, password, next });
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
const csrfIn = (body: string) => /name="_csrf" value="([^"]+)"/.exec(body)![1];

beforeAll(async () => { app = await createTestApp(); });
beforeEach(async () => {
  await resetDb();
  await limiter.reset();
  await seedOperator();
});
afterAll(async () => { await limiter.close(); await app.close(); await closeHelpers(); });

describe('login', () => {
  it('el hash señuelo se calcula al arrancar, no en el primer login con un correo inexistente', () => {
    expect(dummyHashStarted()).toBe(true);
  });

  it('entra con la clave correcta: cookie segura y redirección a next', async () => {
    const res = await login().expect(303);
    expect(res.headers.location).toBe('/panel/costos');
    const c = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(c).toMatch(/^citara_op=[\w-]{43};/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/panel');
  });
  it('misma respuesta para clave mala y correo inexistente', async () => {
    const a = await login('op@citara.co', 'mala-mala-mala').expect(401);
    const b = await login('nadie@citara.co', 'mala-mala-mala').expect(401);
    expect(a.text).toContain('Correo o contraseña incorrectos');
    expect(b.text).toContain('Correo o contraseña incorrectos');
    expect(a.headers['set-cookie']).toBeUndefined();
  });
  it('al quinto fallo bloquea, aunque después llegue la clave correcta', async () => {
    for (let i = 0; i < 5; i++) await login('op@citara.co', 'mala-mala-mala').expect(401);
    const res = await login().expect(429);
    expect(res.text).toContain('Demasiados intentos');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
  it('veinte intentos simultáneos con clave mala: solo cinco llegan a verificarse', async () => {
    const r = await Promise.all(Array.from({ length: 20 }, () => login('op@citara.co', 'mala-mala-mala')));
    expect(r.filter((x) => x.status === 401)).toHaveLength(5);
    expect(r.filter((x) => x.status === 429)).toHaveLength(15);
    await login().expect(429);
  });
  it('entrar bien varias veces seguidas no bloquea', async () => {
    for (let i = 0; i < 7; i++) await login().expect(303);
  });
  it('next solo lleva a rutas del panel', async () => {
    for (const next of ['//evil.com', 'https://evil.com', '/panel/../x', '/\\evil.com', '/otro', '/panel//evil.com']) {
      const res = await login(undefined, undefined, next).expect(303);
      expect(res.headers.location).toBe('/panel');
    }
  });
  it('un operador deshabilitado no entra', async () => {
    await adminQuery(`UPDATE operators SET disabled_at = now()`);
    await login().expect(401);
  });
  it('un POST de login desde otro origen se rechaza', async () => {
    await http().post('/panel/login').set('Origin', 'https://evil.com').type('form')
      .send({ email: 'op@citara.co', password: 'clave-de-prueba-123' }).expect(403);
  });
  it('la página de login lleva las cabeceras de seguridad y escapa el next', async () => {
    const res = await http().get('/panel/login?next=/panel%3Fx%3D%22%3E').expect(200);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    // Con no-referrer, Chrome manda `Origin: null` en los POST de formulario y el
    // panel los rechazaría todos. same-origin no filtra nada hacia otros sitios.
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.text).not.toContain('">"');
  });
});

describe('guard', () => {
  it('sin sesión, un GET redirige al login conservando la ruta', async () => {
    const res = await http().get('/panel?tab=todas&negocio=a').expect(303);
    expect(res.headers.location).toBe('/panel/login?next=%2Fpanel%3Ftab%3Dtodas%26negocio%3Da');
  });
  it('sin sesión, un fragmento de refresco también redirige (el script recarga la página)', async () => {
    await http().get('/panel').set('X-Fragment', 'lista').expect(303);
  });
  it('sin sesión, un POST da 403', async () => {
    await http().post('/panel/negocios/a/conversaciones/11111111-1111-4111-8111-111111111111/tomar').type('form').send({}).expect(403);
  });
  it('un POST con la sesión vencida da una página para volver a entrar, con el texto escrito para copiarlo', async () => {
    const chat = '/panel/negocios/a/conversaciones/11111111-1111-4111-8111-111111111111';
    const res = await http().post(`${chat}/responder`).set('Referer', `http://localhost:3000${chat}`).type('form')
      .send({ texto: 'lo que escribí <b>', envio: 'x' }).expect(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.text).toContain('Tu sesión venció');
    expect(res.text).toContain(`href="/panel/login?next=${encodeURIComponent(chat)}"`);
    expect(res.text).toContain('lo que escribí &lt;b&gt;</textarea>');
  });
  it('cerrar sesión con la sesión ya vencida lleva al login, sin "No se pudo enviar"', async () => {
    const res = await http().post('/panel/logout').type('form').send({}).expect(303);
    expect(res.headers.location).toBe('/panel/login');
  });
  it('el recuadro con el texto conserva un salto de línea inicial y no parte un emoji', async () => {
    const draft = '\nhola ' + '😀'.repeat(4100);
    const res = await http().post('/panel/negocios/a/conversaciones/11111111-1111-4111-8111-111111111111/responder').type('form').send({ texto: draft }).expect(403);
    expect(res.text).toContain('<textarea readonly>\n\nhola 😀');
    expect(res.text).not.toContain('\uFFFD');
    expect((res.text.match(/😀/g) ?? []).length).toBe(4096 - 6);
  });
  it('un Referer de otro sitio no se usa como destino al volver a entrar', async () => {
    const res = await http().post('/panel/negocios/a/conversaciones/11111111-1111-4111-8111-111111111111/tomar').set('Referer', 'https://evil.com/x').type('form').send({}).expect(403);
    expect(res.text).toContain('href="/panel/login?next=%2Fpanel"');
  });

  it('con sesión pero sin CSRF, o con Origin ajeno, un POST da 403', async () => {
    const cookie = cookieOf(await login());
    const page = await http().get('/panel').set('Cookie', cookie).expect(200);
    const csrf = csrfIn(page.text);
    await http().post('/panel/logout').set('Cookie', cookie).type('form').send({}).expect(403);
    await http().post('/panel/logout').set('Cookie', cookie).type('form').send({ _csrf: 'x' + csrf.slice(1) }).expect(403);
    await http().post('/panel/logout').set('Cookie', cookie).set('Origin', 'https://evil.com')
      .type('form').send({ _csrf: csrf }).expect(403);
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toHaveLength(1);
  });
  it('el refresco automático no cuenta como uso: la sesión vence a las 12 h aunque la pestaña siga abierta', async () => {
    const cookie = cookieOf(await login());
    const age = async () => (await adminQuery(
      `SELECT extract(epoch FROM now() - last_seen_at)::int AS s FROM operator_sessions`))[0].s as number;
    await adminQuery(`UPDATE operator_sessions SET last_seen_at = now() - interval '2 hours'`);
    await http().get('/panel').set('Cookie', cookie).set('X-Fragment', 'lista').expect(200);
    expect(await age()).toBeGreaterThan(7000);
    await http().get('/panel').set('Cookie', cookie).expect(200);
    expect(await age()).toBeLessThan(60);
  });
  it('salir borra la sesión y la cookie', async () => {
    const cookie = cookieOf(await login());
    const page = await http().get('/panel').set('Cookie', cookie).expect(200);
    const res = await http().post('/panel/logout').set('Cookie', cookie).set('Origin', 'http://localhost:3000')
      .type('form').send({ _csrf: csrfIn(page.text) }).expect(303);
    expect(res.headers.location).toBe('/panel/login');
    expect(await adminQuery(`SELECT * FROM operator_sessions`)).toEqual([]);
    await http().get('/panel').set('Cookie', cookie).expect(303);
  });
  it('todo controlador del panel lleva PanelGuard a nivel de clase', () => {
    const controllers: Function[] = Reflect.getMetadata('controllers', AppModule);
    const panel = controllers.filter((c) => String(Reflect.getMetadata('path', c)).startsWith('panel'));
    // El de login es el único sin guard: es la puerta.
    const sinGuard = panel.filter((c) => c.name !== 'PanelLoginController'
      && !(Reflect.getMetadata(GUARDS_METADATA, c) ?? []).includes(PanelGuard));
    expect(panel.length).toBeGreaterThanOrEqual(2);
    expect(sinGuard).toEqual([]);
    expect(PANEL_CONTROLLERS.every((c) => panel.includes(c))).toBe(true);
  });
});
