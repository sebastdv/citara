import { Injectable } from '@nestjs/common';
// Import de VALOR, no `import type`: InboundProcessor es @Injectable() y
// recibe DataSource por constructor. Con emitDecoratorMetadata activo, un
// `import type` se borra en la emisión y el design:paramtype queda en
// `Object`, así que Nest ya no puede resolver esta dependencia. Esto ya
// mordió en la Task 8 (ver ingest.service.ts) y solo revienta cuando algo
// arma el módulo de verdad (el worker con ctx.get(...)); los tests de este
// archivo construyen el procesador a mano y no lo habrían detectado.
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import type { InboundJob } from './inbound.queue';

@Injectable()
export class InboundProcessor {
  constructor(private readonly ds: DataSource) {}

  async process(job: InboundJob): Promise<{ conversationId: string; messageId: string }> {
    const r = await runInTenant(this.ds, job.tenantId, (m) => this.persist(m, job));
    return { conversationId: r.conversationId, messageId: r.duplicate ? '' : r.messageId };
  }

  /**
   * Persiste el entrante DENTRO de la transacción de quien llama. FlowRunner
   * lo usa así para que guardar el mensaje y avanzar el flujo sean atómicos:
   * con dos transacciones, un fallo al avanzar dejaba el entrante guardado,
   * el reintento lo veía como duplicado y el usuario se quedaba sin respuesta.
   *
   * El upsert de `conversations` toma el lock de la fila hasta el commit, así
   * que dos mensajes del mismo contacto quedan serializados desde aquí.
   *
   * `messageId` es siempre el id del entrante, también si ya existía.
   */
  async persist(
    m: EntityManager, job: InboundJob,
  ): Promise<{ conversationId: string; messageId: string; duplicate: boolean }> {
    const { tenantId, channelId, message } = job;

    const [contact] = await m.query(
      `INSERT INTO contacts (tenant_id, wa_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, wa_id)
         DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name)
       RETURNING id`,
      [tenantId, message.from, message.profileName],
    );

    // GREATEST: Meta no garantiza orden y el worker procesa en paralelo; un
    // mensaje viejo procesado tarde no puede encoger la ventana de 24 h.
    const [conversation] = await m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed'
         DO UPDATE SET last_inbound_at = GREATEST(conversations.last_inbound_at,
                                                  EXCLUDED.last_inbound_at),
                       updated_at = now()
       RETURNING id`,
      [tenantId, contact.id, channelId, message.timestamp],
    );

    const [saved] = await m.query(
      // El índice de `wamid` es PARCIAL (`WHERE wamid IS NOT NULL`, ver la
      // migración de Task 7): Postgres no infiere un índice parcial sin que
      // el ON CONFLICT repita su predicado.
      `INSERT INTO messages (tenant_id, conversation_id, wamid, direction, type, body, payload)
       VALUES ($1, $2, $3, 'in', $4, $5, $6)
       ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, conversation.id, message.wamid, message.type,
       message.text, JSON.stringify(message.raw)],
    );
    if (saved) return { conversationId: conversation.id, messageId: saved.id, duplicate: false };

    const [existing] = await m.query(
      `SELECT id FROM messages WHERE wamid = $1`, [message.wamid]);
    // El wamid es global de Meta; si choca y RLS no deja verlo, es de OTRO
    // tenant. No debería pasar nunca, pero no se finge que es nuestro.
    if (!existing) throw new Error(`wamid ${message.wamid} ya existe fuera de este tenant`);
    return { conversationId: conversation.id, messageId: existing.id, duplicate: true };
  }
}
