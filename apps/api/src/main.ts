// Debe ser el primer import: instala el polyfill de metadata de reflexión que
// `emitDecoratorMetadata` necesita para que Nest resuelva las dependencias del
// constructor por tipo. Sin esto, cualquier decorador que se evalúe antes
// (incluidas las entidades de TypeORM) lo haría sin Reflect.defineMetadata
// disponible.
import 'reflect-metadata';
// La configuración se lee del entorno. En un servidor la inyecta el
// orquestador, pero en local vive en `.env`, y sin esto el proceso arranca con
// todas las variables en undefined y falla mucho más adentro, con un error que
// no menciona la causa.
import { config } from 'dotenv';
config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true es indispensable — la firma HMAC se calcula sobre los bytes
  // originales, y reserializar el JSON los cambia.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // SIGTERM (un despliegue, `docker compose stop`): cerrar el servidor y las
  // conexiones en orden, en vez de esperar a que Docker lo mate a los 15 s.
  app.enableShutdownHooks();
  // Detrás de Caddy, la IP del cliente viene en X-Forwarded-For: sin esto el
  // límite de intentos del panel contaría todo a la IP del proxy.
  const trust = process.env.TRUST_PROXY;
  if (trust) app.getHttpAdapter().getInstance().set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
