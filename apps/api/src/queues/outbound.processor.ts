import { Injectable } from '@nestjs/common';
// Import de VALOR, no `import type`: OutboundProcessor es @Injectable() y
// recibe DataSource, ChannelResolver y MetaSender por constructor. Con
// emitDecoratorMetadata activo, un `import type` se borra en la emisión y el
// design:paramtype queda en `Object`, y Nest ya no puede resolver la
// dependencia. Ver la misma nota en inbound.processor.ts (Task 9): ese fallo
// solo aparece cuando algo arma el módulo de verdad (el worker con
// ctx.get(...)), no en los tests de este archivo, que construyen el
// procesador a mano.
import { DataSource } from 'typeorm';
import { ChannelResolver } from '../tenancy/channel-resolver.service';
import { MetaSender } from '../whatsapp/sender';
import { runInTenant } from '../tenancy/tenant-context';
import type { OutboundJob } from './outbound.queue';

@Injectable()
export class OutboundProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly sender: MetaSender,
  ) {}

  async process(job: OutboundJob): Promise<{ messageId: string; wamid: string }> {
    const { tenantId, channelId, conversationId, to, content } = job;

    // Se resuelve el canal por su id, no por phone_number_id: quien encoló
    // ya sabe a qué canal pertenece esta conversación. Sin default: si el
    // canal no existe o quedó inactivo, mejor fallar el job (y que BullMQ lo
    // reintente/lo deje para inspección) que enviar con credenciales
    // equivocadas.
    const channel = await this.channels.resolveById(channelId);
    if (!channel) {
      throw new Error(`No se pudo resolver el canal ${channelId} para el envío saliente`);
    }

    const { wamid } = await this.sender.send(channel, to, content);

    // `messages.type` se guarda con el MISMO vocabulario que el entrante, que
    // es el de Meta. El panel muestra la conversación completa en una sola
    // lista, así que una columna cuyo significado dependiera de `direction`
    // obligaría a cada consumidor a saberlo. Botones y lista son las dos formas
    // de un mensaje interactivo — justo lo que el entrante registra como
    // 'interactive'. El `kind` fino no se pierde: viaja en `payload`.
    const type = content.kind === 'text' ? 'text' : 'interactive';

    return runInTenant(this.ds, tenantId, async (m) => {
      const [saved] = await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, type, body, payload)
         VALUES ($1, $2, $3, 'out', $4, $5, $6)
         RETURNING id`,
        [tenantId, conversationId, wamid, type, content.body, JSON.stringify(content)],
      );
      return { messageId: saved.id, wamid };
    });
  }
}
