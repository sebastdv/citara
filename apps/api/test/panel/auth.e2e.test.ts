import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { LoginLimiter } from '../../src/panel/login-limiter';
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
    await http().post('/panel/logout').type('form').send({}).expect(403);
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
