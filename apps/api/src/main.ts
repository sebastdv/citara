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
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
