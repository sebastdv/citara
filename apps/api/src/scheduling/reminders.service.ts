import { Injectable } from '@nestjs/common';
// Import de VALOR: servicio Nest con DataSource por constructor.
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { OutboundContent } from '@citara/shared';
import { runInTenant } from '../tenancy/tenant-context';
import type { MessageOutboundJob } from '../queues/outbound.queue';
import { labelFor } from './format';

/** Deben estar APROBADAS en Meta con tres parámetros: nombre, fecha y hora, servicio. */
export const REMINDER_TEMPLATES = { '24h': 'recordatorio_cita_24h', '2h': 'recordatorio_cita_2h' } as const;
const OFFSETS = [{ kind: '24h', minutes: 24 * 60 }, { kind: '2h', minutes: 2 * 60 }] as const;
/** Por debajo del tope de 20 mensajes por segundo de un número en coexistencia. */
const PER_CHANNEL_PER_SECOND = 10;
/** Un recordatorio pendiente más viejo que esto se considera huérfano del encolado. */
const ORPHAN_AFTER = `2 minutes`;
/** Con la cita a 2 h o menos, el de 24 h sobra: sale el de 2 h. */
const STALE_24H_WITHIN_MS = 2 * 60 * 60_000;

@Injectable()
export class RemindersService {
  constructor(private readonly ds: DataSource) {}

  async scheduleFor(m: EntityManager, tenantId: string, appointmentId: string, startsAt: Date, now: Date) {
    for (const o of OFFSETS) {
      const sendAt = new Date(startsAt.getTime() - o.minutes * 60_000);
      if (sendAt <= now) continue; // ya pasó: no se programa
      await m.query(
        `INSERT INTO reminders (tenant_id, appointment_id, kind, send_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (appointment_id, kind) DO NOTHING`, [tenantId, appointmentId, o.kind, sendAt]);
    }
  }

  /** La cita se movió: lo de la hora vieja se retira y se programa lo de la nueva. */
  async rescheduleFor(m: EntityManager, tenantId: string, appointmentId: string, startsAt: Date, now: Date) {
    await this.retireQueued(m, appointmentId);
    await m.query(`DELETE FROM reminders WHERE appointment_id = $1`, [appointmentId]);
    await this.scheduleFor(m, tenantId, appointmentId, startsAt, now);
  }

  /** La cita se canceló: ni lo programado ni lo ya encolado debe salir. */
  async cancelFor(m: EntityManager, appointmentId: string) {
    await this.retireQueued(m, appointmentId);
    await m.query(
      `UPDATE reminders SET status = 'cancelled'
        WHERE appointment_id = $1 AND status IN ('pending', 'queued')`, [appointmentId]);
  }

  /**
   * Un recordatorio ya convertido en mensaje puede estar esperando en la cola
   * (backoff de Meta, un barrido concurrente): su mensaje `pending` pasa a
   * `superseded` para que el envío no lo saque con la hora vieja.
   */
  private async retireQueued(m: EntityManager, appointmentId: string) {
    await m.query(
      `UPDATE messages SET status = 'superseded'
        WHERE status = 'pending'
          AND id IN (SELECT message_id FROM reminders
                      WHERE appointment_id = $1 AND status = 'queued' AND message_id IS NOT NULL)`,
      [appointmentId]);
  }

  /**
   * Convierte los recordatorios vencidos de todos los negocios en mensajes
   * plantilla `pending` (outbox) y devuelve los jobs a encolar, con su retraso.
   *
   * Itera negocios en vez de un SELECT global porque `reminders` tiene RLS: sin
   * `app.tenant_id` devuelve cero filas (D2). Un barrido global exigiría una
   * conexión privilegiada, que es justo como se filtran datos entre clientes.
   */
  async sweep(now: Date): Promise<{ job: MessageOutboundJob; delay: number }[]> {
    // `tenants` es la raíz y no lleva RLS: es la única lectura sin contexto.
    const tenants: { id: string; timezone: string }[] =
      await this.ds.query(`SELECT id, timezone FROM tenants WHERE status = 'active'`);

    const jobs: MessageOutboundJob[] = [];
    for (const t of tenants) {
      jobs.push(...await runInTenant(this.ds, t.id, (m) => this.sweepTenant(m, t.id, t.timezone, now)));
    }

    // Reparto por canal: un lote grande no puede salir de golpe.
    const perChannel = new Map<string, number>();
    return jobs.map((job) => {
      const i = perChannel.get(job.channelId) ?? 0;
      perChannel.set(job.channelId, i + 1);
      return { job, delay: Math.floor(i / PER_CHANNEL_PER_SECOND) * 1000 };
    });
  }

  private async sweepTenant(m: EntityManager, tenantId: string, timezone: string, now: Date) {
    const jobs: MessageOutboundJob[] = [];
    // SKIP LOCKED: dos workers barriendo a la vez no toman el mismo recordatorio.
    const due = await m.query(
      `SELECT r.id, r.kind, a.starts_at, a.status AS appointment_status, a.conversation_id,
              a.customer_name, a.contact_id, k.wa_id, k.name AS contact_name, s.name AS service_name
         FROM reminders r
         JOIN appointments a ON a.id = r.appointment_id
         JOIN contacts k ON k.id = a.contact_id
         JOIN services s ON s.id = a.service_id
        WHERE r.status = 'pending' AND r.send_at <= $1
        ORDER BY r.send_at
        LIMIT 500
        FOR UPDATE OF r SKIP LOCKED`, [now]);

    for (const row of due) {
      const startsAt = new Date(row.starts_at).getTime();
      // No sale: la cita ya no está, ya pasó (canal caído, negocio suspendido,
      // worker detenido), o es el de 24 h atrasado cuando ya toca el de 2 h.
      const stale = row.appointment_status !== 'confirmed'
        || startsAt <= now.getTime()
        || (row.kind === '24h' && startsAt - now.getTime() <= STALE_24H_WITHIN_MS);
      if (stale) {
        await m.query(`UPDATE reminders SET status = 'cancelled' WHERE id = $1`, [row.id]);
        continue;
      }
      const conv = await this.conversationFor(m, tenantId, row.conversation_id, row.contact_id);
      if (!conv) continue; // sin canal activo: queda pendiente para el próximo barrido

      const content: OutboundContent = {
        kind: 'template',
        name: REMINDER_TEMPLATES[row.kind as '24h' | '2h'],
        language: 'es',
        params: [row.customer_name || row.contact_name || 'cliente', labelFor(row.starts_at, timezone), row.service_name],
      };
      const [msg] = await m.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, payload, status)
         VALUES ($1, $2, 'out', 'reminder', 'template', $3, 'pending') RETURNING id`,
        [tenantId, conv.id, JSON.stringify(content)]);
      await m.query(`UPDATE reminders SET status = 'queued', message_id = $2 WHERE id = $1`, [row.id, msg.id]);
      jobs.push({ tenantId, channelId: conv.channelId, conversationId: conv.id, to: row.wa_id, messageId: msg.id });
    }

    // Outbox: un recordatorio guardado cuyo encolado falló se vuelve a encolar.
    const orphans = await m.query(
      `SELECT msg.id, msg.conversation_id, c.channel_id, k.wa_id
         FROM messages msg
         JOIN conversations c ON c.id = msg.conversation_id
         JOIN contacts k ON k.id = c.contact_id
        WHERE msg.origin = 'reminder' AND msg.status = 'pending'
          AND msg.created_at < now() - interval '${ORPHAN_AFTER}'`);
    for (const o of orphans) {
      jobs.push({ tenantId, channelId: o.channel_id, conversationId: o.conversation_id, to: o.wa_id, messageId: o.id });
    }
    return jobs;
  }

  /** La conversación de la cita si sigue abierta; si no, la abierta del contacto; si no, una nueva. */
  private async conversationFor(m: EntityManager, tenantId: string, conversationId: string | null, contactId: string) {
    const [current] = await m.query(
      `SELECT id, channel_id FROM conversations
        WHERE status = 'open' AND (id = $1 OR contact_id = $2)
        ORDER BY (id = $1) DESC, updated_at DESC LIMIT 1`, [conversationId, contactId]);
    if (current) return { id: current.id as string, channelId: current.channel_id as string };

    // whatsapp_channels no lleva RLS: se filtra por tenant explícitamente.
    const [channel] = await m.query(
      `SELECT id FROM whatsapp_channels WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
      [tenantId]);
    if (!channel) return null;
    const [created] = await m.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, contact_id, channel_id) WHERE status <> 'closed' DO UPDATE SET updated_at = now()
       RETURNING id`, [tenantId, contactId, channel.id]);
    return { id: created.id as string, channelId: channel.id as string };
  }
}
