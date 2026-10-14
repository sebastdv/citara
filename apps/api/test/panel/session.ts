import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { LoginLimiter } from '../../src/panel/login-limiter';
import { seedOperator } from '../helpers';

export const csrfIn = (body: string) => /name="_csrf" value="([^"]+)"/.exec(body)![1];
export const envioIn = (body: string) => /name="envio" value="([^"]+)"/.exec(body)![1];

/** Crea el operador, entra y devuelve un cliente con la cookie puesta. */
export async function panelSession(app: INestApplication) {
  const limiter = new LoginLimiter(process.env.REDIS_URL!);
  await limiter.reset();
  await limiter.close();
  await seedOperator();
  const http = () => request(app.getHttpServer());
  const res = await http().post('/panel/login').type('form')
    .send({ email: 'op@citara.co', password: 'clave-de-prueba-123' }).expect(303);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const get = (path: string) => http().get(path).set('Cookie', cookie);
  /** POST con el csrf de la página `from` (o de la bandeja). */
  const post = async (path: string, body: Record<string, string> = {}, from = '/panel') => {
    const page = await get(from).expect(200);
    return http().post(path).set('Cookie', cookie).type('form').send({ _csrf: csrfIn(page.text), ...body });
  };
  return { http, cookie, get, post };
}
