import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
// Import de VALOR, no `import type`: OutboundProcessor es @Injectable() y
// recibe DataSource, ChannelResolver y MetaSender por constructor. Con
// emitDecoratorMetadata activo, un `import type` se borra en la emisión y el
// design:paramtype queda en `Object`, y Nest ya no puede resolver la
// dependencia. Ver la misma nota en inbound.processor.ts (Task 9).
import { DataSource } from 'typeorm';
import type { OutboundContent } from '@citara/shared';
import { ChannelResolver } from '../tenancy/channel-resolver.service';
import { MetaSender, MetaSendError } from '../whatsapp/sender';
import { runInTenant } from '../tenancy/tenant-context';
import { canSendFreeform, requiresOpenWindow } from '../conversations/session-window';
import { botRepliesSuperseded, type ControlState } from '../conversations/control';
import type { OutboundJob } from './outbound.queue';

/** Más que el timeout del envío (15 s) con margen: pasado esto, el intento murió. */
const CLAIM_STALE_SECONDS = 60;

/**
 * Estados de un saliente: `pending` (lo produjo el flujo) → `sending`
 * (reclamado por un envío, con `claimed_at`) → `sent`. Salidas laterales:
 * `window_closed`, `failed` (rechazo permanente, canal inválido o reintentos
 * agotados), `unconfirmed` (pudo o no llegar a Meta; no se reenvía a ciegas) y
 * `superseded` (un humano tomó la conversación antes de que saliera, o el
 * negocio dejó de estar activo).
 *
 * TODA transición es compare-and-set sobre el estado previo: dos ejecuciones
 * del mismo turno (un job atascado que BullMQ re-ejecuta mientras el original
 * sigue vivo) nunca se pisan el resultado.
 */
@Injectable()
export class OutboundProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly sender: MetaSender,
  ) {}

  async process(job: OutboundJob): Promise<{ sent: number }> {
    const { tenantId, channelId, to } = job;
    // Qué filas son de este job: las de un turno, o un mensaje suelto.
    const [column, key] = 'turnId' in job ? ['reply_to_id', job.turnId] : ['id', job.messageId];

    // Sin default ni reintentos: un canal que no existe, quedó inactivo o es
    // de otro negocio no se arregla en el siguiente intento.
    const channel = await this.channels.resolveById(channelId);
    const invalid = !channel
      ? `No se pudo resolver el canal ${channelId} para el envío saliente`
      : channel.tenantId !== tenantId
        ? `El canal ${channelId} no pertenece al tenant ${tenantId}`
        : null;
    if (invalid || !channel) {
      await this.failPending(job);
      throw new UnrecoverableError(invalid ?? 'canal inválido');
    }

    const { rows, control, lastInboundAt, tenantStatus } = await runInTenant(this.ds, tenantId, async (m) => {
      const rows: {
        id: string; status: string; in_flight: boolean; payload: OutboundContent; origin: string;
      }[] =
        await m.query(
          `SELECT id, status, payload, origin,
                  coalesce(claimed_at > now() - make_interval(secs => $2), false) AS in_flight
             FROM messages
            WHERE ${column} = $1 AND direction = 'out' AND status IN ('pending', 'sending')
            ORDER BY seq`,
          [key, CLAIM_STALE_SECONDS],
        );
      const [conv] = await m.query(
        `SELECT last_inbound_at, control, human_until, control_reason
           FROM conversations WHERE id = $1`, [job.conversationId]);
      const control: ControlState = {
        control: conv?.control ?? 'bot',
        humanUntil: conv?.human_until ? new Date(conv.human_until) : null,
        reason: conv?.control_reason ?? null,
      };
      const [tenant] = await m.query(`SELECT status FROM tenants WHERE id = $1`, [tenantId]);
      return { rows, control, lastInboundAt: (conv?.last_inbound_at as Date | undefined) ?? null,
               tenantStatus: tenant?.status as string | undefined };
    });

    // Suspender es inmediato (spec §8): lo que esperaba en la cola o en
    // reintentos ya no sale, sea del bot, un recordatorio o del operador.
    if (tenantStatus !== 'active') {
      await this.closePending(job, 'superseded');
      return { sent: 0 };
    }

    let sent = 0;
    for (const row of rows) {
      if (row.status === 'sending') {
        // Otro intento la tiene entre manos: ni se toca ni se adelanta el
        // resto del turno (rompería el orden). BullMQ reintenta más tarde.
        if (row.in_flight) throw new Error(`Envío en curso por otro intento (fila ${row.id})`);
        // Un intento la reclamó y murió: pudo haber llegado a Meta.
        await this.transition(tenantId, row.id, 'sending', 'unconfirmed');
        continue;
      }

      // Spec §6.3: si un humano intervino después de que el bot produjera esto,
      // ya sobra. Se mide AHORA, justo antes de enviar.
      if (row.origin === 'bot' && botRepliesSuperseded(control, new Date())) {
        await this.transition(tenantId, row.id, 'pending', 'superseded');
        continue;
      }

      let needsWindow: boolean;
      try {
        needsWindow = requiresOpenWindow(row.payload);
      } catch {
        // Un `kind` que este código no conoce no va a conocerlo en 5 intentos.
        await this.transition(tenantId, row.id, 'pending', 'failed');
        continue;
      }
      // La ventana se mide AHORA, al enviar: un job puede esperar en la cola y
      // cruzar el límite. No se lanza: reintentar no reabre la ventana.
      if (needsWindow && !canSendFreeform(lastInboundAt, new Date())) {
        await this.transition(tenantId, row.id, 'pending', 'window_closed');
        continue;
      }

      if (row.origin === 'bot') {
        // El control se vuelve a medir aquí, dentro del reclamo atómico: el
        // dueño pudo contestar mientras salía la fila anterior.
        if (!(await this.claimBotReply(tenantId, row.id))) {
          // O manda un humano que intervino (→ superseded), u otro intento la
          // ganó (el CAS desde 'pending' falla y no pasa nada).
          await this.transition(tenantId, row.id, 'pending', 'superseded');
          continue;
        }
      } else if (row.origin === 'reminder') {
        // Un recordatorio solo sale si su cita sigue confirmada: pudo
        // cancelarse o moverse mientras el job esperaba en la cola.
        if (!(await this.claimReminder(tenantId, row.id))) {
          await this.transition(tenantId, row.id, 'pending', 'superseded');
          continue;
        }
      } else if (!(await this.claim(tenantId, row.id))) {
        continue; // otro intento la ganó
      }

      let wamid: string;
      try {
        ({ wamid } = await this.sender.send(channel, to, row.payload));
      } catch (err) {
        const kind = err instanceof MetaSendError ? err.kind : 'retry';
        if (kind === 'ambiguous') {
          await this.transition(tenantId, row.id, 'sending', 'unconfirmed');
          continue;
        }
        if (kind === 'window') {
          // Manda el veredicto de Meta, no nuestro reloj; aplica al turno entero.
          await this.transition(tenantId, row.id, 'sending', 'window_closed');
          await this.closePending(job, 'window_closed');
          return { sent };
        }
        if (kind === 'permanent') {
          // Lo que queda del turno correría la misma suerte (mismo token,
          // misma conversación): se cierra y BullMQ no gasta intentos.
          await this.transition(tenantId, row.id, 'sending', 'failed');
          await this.failPending(job);
          throw new UnrecoverableError((err as Error).message);
        }
        // Reintentable: Meta NO lo aceptó, se libera para el siguiente
        // intento. Se corta aquí para que el resto no adelante a este mensaje.
        await this.transition(tenantId, row.id, 'sending', 'pending');
        throw err;
      }

      // Si este UPDATE falla, la fila queda en `sending` y, pasado el umbral,
      // un reintento la marca `unconfirmed` en vez de volver a enviarla.
      await this.transition(tenantId, row.id, 'sending', 'sent', wamid);
      sent++;
    }
    return { sent };
  }

  /** Al agotar los reintentos: lo que no salió queda como fallido, visible. */
  failTurn(job: OutboundJob) {
    return this.failPending(job);
  }

  /** `pending` → `sending` de forma atómica. Solo un intento gana la fila. */
  private async claim(tenantId: string, id: string): Promise<boolean> {
    return this.transition(tenantId, id, 'pending', 'sending');
  }

  /**
   * Reclamo de una respuesta del bot: además de seguir en `pending`, exige que
   * no mande un humano que intervino (spec §6.3). Es la misma regla que
   * `botRepliesSuperseded`, evaluada por Postgres en el mismo instante del
   * reclamo; entre el reclamo y el envío queda una ventana inherente.
   */
  private async claimBotReply(tenantId: string, id: string): Promise<boolean> {
    const [, affected] = (await runInTenant(this.ds, tenantId, (m) => m.query(
      `UPDATE messages SET status = 'sending', claimed_at = now()
        WHERE id = $1 AND status = 'pending'
          AND NOT EXISTS (
                SELECT 1 FROM conversations c
                 WHERE c.id = messages.conversation_id
                   AND c.control = 'human' AND c.human_until > now()
                   AND c.control_reason IS DISTINCT FROM 'flow_handoff')`,
      [id]))) as [unknown[], number];
    return affected > 0;
  }

  private async claimReminder(tenantId: string, id: string): Promise<boolean> {
    const [, affected] = (await runInTenant(this.ds, tenantId, (m) => m.query(
      `UPDATE messages SET status = 'sending', claimed_at = now()
        WHERE id = $1 AND status = 'pending'
          AND EXISTS (SELECT 1 FROM reminders r JOIN appointments a ON a.id = r.appointment_id
                       WHERE r.message_id = messages.id AND a.status = 'confirmed')`,
      [id]))) as [unknown[], number];
    return affected > 0;
  }

  /**
   * Compare-and-set: solo cambia la fila si sigue en `from`. Devuelve si ganó.
   * Con UPDATE, TypeORM devuelve `[filas, conteo]`, no las filas: leer
   * `.length` del resultado da siempre 2 y la transición "ganaría" siempre.
   */
  private async transition(
    tenantId: string, id: string, from: string, to: string, wamid?: string,
  ): Promise<boolean> {
    const [, affected] = await runInTenant(this.ds, tenantId, (m) => m.query(
      `UPDATE messages
          SET status = $3::varchar,
              wamid = coalesce($4::varchar, wamid),
              claimed_at = CASE WHEN $3::varchar = 'sending' THEN now() ELSE claimed_at END
        WHERE id = $1 AND status = $2`,
      [id, from, to, wamid ?? null])) as [unknown[], number];
    return affected > 0;
  }

  private failPending(job: OutboundJob) {
    return this.closePending(job, 'failed');
  }

  private closePending(job: OutboundJob, to: 'failed' | 'window_closed' | 'superseded') {
    const [column, key] = 'turnId' in job ? ['reply_to_id', job.turnId] : ['id', job.messageId];
    return runInTenant(this.ds, job.tenantId, (m) => m.query(
      `UPDATE messages SET status = $2 WHERE ${column} = $1 AND status = 'pending'`, [key, to]));
  }
}
