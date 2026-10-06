import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { EncryptionService } from './crypto/encryption.service';
import { ChannelResolver } from './tenancy/channel-resolver.service';
import { InboundQueue } from './queues/inbound.queue';
import { InboundProcessor } from './queues/inbound.processor';
import { OutboundQueue } from './queues/outbound.queue';
import { OutboundProcessor } from './queues/outbound.processor';
import { IngestService } from './whatsapp/ingest.service';
import { MetaSender } from './whatsapp/sender';
import { WhatsappController } from './whatsapp/whatsapp.controller';
import { FlowRunner } from './flow-engine/flow-runner.service';
import { SyncQueue } from './queues/sync.queue';
import { AvailabilityService } from './scheduling/availability.service';
import { BookingService } from './scheduling/booking.service';
import { ToolRegistry } from './scheduling/tools/registry';
import { EchoProcessor } from './coexistence/echo.processor';
import { StatusProcessor } from './queues/status.processor';
import { HistoryProcessor } from './coexistence/history.processor';
import { ContactsSyncProcessor } from './coexistence/contacts-sync.processor';
import { AccountUpdateProcessor } from './coexistence/account-update.processor';

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
    // Registrado como provider a propósito: apps/worker lo resuelve con
    // ctx.get(InboundProcessor) (ver apps/worker/src/main.ts). Sin esta
    // entrada, Nest arranca el módulo igual (nada más lo reclama) y el
    // worker revienta recién al bootear con "UnknownElementException" — un
    // fallo invisible para los tests de este archivo porque construyen el
    // procesador a mano (`new InboundProcessor(app)`) sin pasar por Nest.
    InboundProcessor,
    {
      // MetaSender no lleva @Injectable(): se construye a mano, igual que
      // ChannelResolver arriba. El graphVersion viene del entorno; NUNCA el
      // phone_number_id, que es propiedad de cada canal (ver sender.ts).
      provide: MetaSender,
      useFactory: () => new MetaSender(process.env.META_GRAPH_VERSION!),
    },
    OutboundQueue,
    SyncQueue,
    // Mismo motivo que InboundProcessor arriba: apps/worker lo resuelve con
    // ctx.get(OutboundProcessor) para consumir la cola de salida. Sin esta
    // entrada el worker arranca "bien" y revienta después con
    // UnknownElementException, invisible para los tests de este archivo.
    OutboundProcessor,
    IngestService,
    // Registrado como provider por el mismo motivo que InboundProcessor y
    // OutboundProcessor arriba: apps/worker lo resuelve con
    // ctx.get(FlowRunner) para procesar la cola de entrada de punta a punta
    // (persistir + avanzar el flujo + encolar la salida). Sin esta entrada
    // el worker arranca "bien" y revienta después con
    // UnknownElementException, invisible para los tests de este archivo
    // porque construyen FlowRunner a mano.
    FlowRunner,
    // Lo resuelve apps/worker con ctx.get(...) al despachar la cola inbound.
    // Sin esta entrada el worker arranca y revienta después con
    // UnknownElementException, invisible para los tests que lo construyen a mano.
    EchoProcessor,
    // Mismo motivo que EchoProcessor: el worker lo resuelve con ctx.get(...).
    StatusProcessor,
    // Consumidores de la cola `sync`; mismo motivo que EchoProcessor.
    HistoryProcessor,
    ContactsSyncProcessor,
    // Mismo motivo que EchoProcessor: el worker lo resuelve con ctx.get(...).
    AccountUpdateProcessor,
    // Agenda (Fase 2). Sin estado: reciben el EntityManager de quien llama.
    AvailabilityService,
    BookingService,
    ToolRegistry,
  ],
})
export class AppModule {}
