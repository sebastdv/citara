import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from './crypto/encryption.service';
import { ChannelResolver } from './tenancy/channel-resolver.service';
import { InboundQueue } from './queues/inbound.queue';
import { IngestService } from './whatsapp/ingest.service';
import { WhatsappController } from './whatsapp/whatsapp.controller';

@Module({
  controllers: [WhatsappController],
  providers: [
    {
      // DataSource de la APLICACIÓN (DATABASE_URL, rol citara_app) — nunca el
      // de administración. RLS depende de que la app jamás se conecte como
      // dueña de las tablas; ese rol es solo para migraciones y para los
      // helpers de test.
      provide: DataSource,
      useFactory: async () => {
        const ds = createDataSource(process.env.DATABASE_URL!);
        await ds.initialize();
        return ds;
      },
    },
    {
      // Provider ASÍNCRONO a propósito: EncryptionService envuelve libsodium,
      // que carga su WASM de forma asíncrona (`sodium.ready`). Si Nest
      // resolviera este provider de forma síncrona, el módulo terminaría de
      // arrancar antes de que libsodium esté listo y el primer
      // encrypt()/decrypt() fallaría con
      // "TypeError: sodium.randombytes_buf is not a function" — un mensaje
      // que no menciona `ready()` en ningún lado. Al declarar el factory como
      // `async` y hacer `await svc.ready()` dentro, Nest no da por terminado
      // el arranque del módulo hasta que libsodium esté disponible.
      provide: EncryptionService,
      useFactory: async () => {
        const svc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
        await svc.ready();
        return svc;
      },
    },
    {
      // ChannelResolver no lleva @Injectable(): se construye a mano con sus
      // dos dependencias ya resueltas por Nest.
      provide: ChannelResolver,
      useFactory: (ds: DataSource, enc: EncryptionService) => new ChannelResolver(ds, enc),
      inject: [DataSource, EncryptionService],
    },
    InboundQueue,
    IngestService,
  ],
})
export class AppModule {}
