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
import type { OutboundJob } from './outbound.queue';

/**
 * Estados de un saliente: `pending` (lo produjo el flujo) → `sending`
 * (reclamado por un envío) → `sent`. Salidas laterales: `window_closed`,
 * `failed` (Meta lo rechazó de forma permanente) y `unconfirmed` (un intento
 * lo reclamó y murió sin confirmar: pudo o no llegar a Meta).
 */
@Injectable()
export class OutboundProcessor {
  constructor(
    private readonly ds: DataSource,
    private readonly channels: ChannelResolver,
    private readonly sender: MetaSender,
  ) {}

  async process(job: OutboundJob): Promise<{ sent: number }> {
    const { tenantId, channelId, turnId, to } = job;

    // Sin default ni reintentos: un canal que no existe o quedó inactivo no
    // va a aparecer en el siguiente intento.
    const channel = await this.channels.resolveById(channelId);
    if (!channel) {
      throw new UnrecoverableError(`No se pudo resolver el canal ${channelId} para el envío saliente`);
    }
    if (channel.tenantId !== tenantId) {
      throw new UnrecoverableError(`El canal ${channelId} no pertenece al tenant ${tenantId}`);
    }

    const { rows, lastInboundAt } = await runInTenant(this.ds, tenantId, async (m) => {
      const rows: { id: string; status: string; payload: OutboundContent }[] = await m.query(
        `SELECT id, status, payload FROM messages
          WHERE reply_to_id = $1 AND direction = 'out' AND status IN ('pending', 'sending')
          ORDER BY seq`,
        [turnId],
      );
      const [conv] = await m.query(
        `SELECT last_inbound_at FROM conversations WHERE id = $1`, [job.conversationId]);
      return { rows, lastInboundAt: (conv?.last_inbound_at as Date | undefined) ?? null };
    });

    let sent = 0;
    for (const [i, row] of rows.entries()) {
      if (row.status === 'sending') {
        // At-most-once: un intento anterior la reclamó y murió. Reenviar a
        // ciegas puede duplicarle el mensaje al usuario.
        await this.setStatus(tenantId, row.id, 'unconfirmed');
        continue;
      }

      // La ventana se mide AHORA, al enviar, no cuando el flujo produjo el
      // mensaje: un job puede esperar en la cola y cruzar el límite. No se
      // lanza: reintentar no reabre la ventana.
      if (requiresOpenWindow(row.payload) && !canSendFreeform(lastInboundAt, new Date())) {
        await this.setStatus(tenantId, row.id, 'window_closed');
        continue;
      }

      if (!(await this.claim(tenantId, row.id))) continue; // otro intento la tomó

      let wamid: string;
      try {
        ({ wamid } = await this.sender.send(channel, to, row.payload));
      } catch (err) {
        if (err instanceof MetaSendError && err.permanent) {
          // Lo que queda del turno correría la misma suerte (mismo token,
          // misma ventana): se cierra entero y BullMQ no gasta intentos.
          for (const r of rows.slice(i)) await this.setStatus(tenantId, r.id, 'failed');
          throw new UnrecoverableError(err.message);
        }
        // Transitorio: Meta no lo aceptó, se libera para el reintento. Se
        // corta aquí para que el resto del turno no adelante a este mensaje.
        await this.setStatus(tenantId, row.id, 'pending');
        throw err;
      }

      // Si este UPDATE falla, la fila queda en `sending` y el reintento la
      // marca `unconfirmed` en vez de volver a enviarla.
      await runInTenant(this.ds, tenantId, (m) => m.query(
        `UPDATE messages SET wamid = $1, status = 'sent' WHERE id = $2`, [wamid, row.id]));
      sent++;
    }
    return { sent };
  }

  /** `pending` → `sending` de forma atómica. Solo un intento gana la fila. */
  private async claim(tenantId: string, id: string): Promise<boolean> {
    // Con UPDATE, TypeORM devuelve `[filas, conteo]`, no las filas: leer
    // `.length` del resultado da siempre 2 y el reclamo "ganaría" siempre.
    const [, affected] = await runInTenant(this.ds, tenantId, (m) => m.query(
      `UPDATE messages SET status = 'sending' WHERE id = $1 AND status = 'pending'`,
      [id])) as [unknown[], number];
    return affected > 0;
  }

  private setStatus(tenantId: string, id: string, status: string) {
    return runInTenant(this.ds, tenantId, (m) => m.query(
      `UPDATE messages SET status = $1 WHERE id = $2`, [status, id]));
  }
}
