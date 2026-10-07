import type { EntityManager } from 'typeorm';
import { recordAudit } from '../audit/audit';

/**
 * Quién habla en una conversación (spec §6). Fuente única de verdad:
 * `conversations.control` + `human_until`. No hay job que devuelva el control
 * al bot: se evalúa en el siguiente evento.
 */
export type ControlReason = 'phone' | 'flow_handoff' | 'operator' | 'history';

export interface ControlState {
  control: 'bot' | 'human';
  humanUntil: Date | null;
  reason: ControlReason | null;
}

/** ¿Manda un humano ahora mismo? Un control humano vencido, o sin plazo, no cuenta. */
export function humanInControl(s: ControlState, now: Date): boolean {
  return s.control === 'human' && s.humanUntil !== null && s.humanUntil.getTime() > now.getTime();
}

/** El humano tuvo el control y se le venció: toca devolvérselo al bot. */
export function humanControlExpired(s: ControlState, now: Date): boolean {
  return s.control === 'human' && !humanInControl(s, now);
}

/**
 * ¿Lo que el bot dejó pendiente ya sobra? Solo si un humano INTERVINO. Cuando
 * el control lo dio el propio flujo, su mensaje de traspaso se produjo en el
 * mismo turno y debe salir.
 */
export function botRepliesSuperseded(s: ControlState, now: Date): boolean {
  return humanInControl(s, now) && s.reason !== 'flow_handoff';
}

export async function readControl(
  m: EntityManager, conversationId: string,
): Promise<ControlState & { channelStatus: string; tenantStatus: string }> {
  const [row] = await m.query(
    `SELECT c.control, c.human_until, c.control_reason, ch.status AS channel_status, t.status AS tenant_status
       FROM conversations c
       JOIN whatsapp_channels ch ON ch.id = c.channel_id
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1`,
    [conversationId],
  );
  if (!row) throw new Error(`Conversación ${conversationId} no encontrada`);
  return {
    control: row.control,
    humanUntil: row.human_until ? new Date(row.human_until) : null,
    reason: row.control_reason,
    channelStatus: row.channel_status,
    tenantStatus: row.tenant_status,
  };
}

/** El humano toma la conversación desde `from` por las horas del negocio. */
export async function giveControlToHuman(
  m: EntityManager,
  a: { tenantId: string; conversationId: string; from: Date; reason: ControlReason; actor: string },
): Promise<void> {
  const before = await readControl(m, a.conversationId);
  const [tenant] = await m.query(
    `SELECT human_takeover_hours AS hours FROM tenants WHERE id = $1`, [a.tenantId]);

  // GREATEST ignora NULL: la primera intervención fija el plazo y las
  // siguientes solo lo alargan. Un eco viejo procesado tarde no lo acorta.
  // Y si su plazo YA venció (reentrega tras una caída, cola atrasada) no toca
  // nada: dejar control='human' vencido haría que el siguiente mensaje del
  // cliente lo "devolviera" al bot cerrándole la sesión a medias, y la
  // bitácora registraría un traspaso que nadie hizo. Con UPDATE, TypeORM
  // devuelve [filas, conteo].
  const [, affected] = (await m.query(
    `UPDATE conversations
        SET control = 'human',
            human_until = GREATEST(human_until, $2::timestamptz + make_interval(hours => $3::int)),
            control_reason = $4,
            updated_at = now()
      WHERE id = $1 AND $2::timestamptz + make_interval(hours => $3::int) > now()`,
    [a.conversationId, a.from, tenant.hours, a.reason],
  )) as [unknown[], number];
  if (affected === 0) return;

  // Se audita el CAMBIO de quién habla, no cada eco que alarga el plazo.
  if (!humanInControl(before, new Date())) {
    await recordAudit(m, {
      tenantId: a.tenantId, actor: a.actor, action: 'control.to_human',
      conversationId: a.conversationId, details: { reason: a.reason },
    });
  }
}

/** El bot vuelve a hablar: venció el plazo o el operador lo devolvió. */
export async function returnControlToBot(
  m: EntityManager,
  a: { tenantId: string; conversationId: string; cause: 'expired' | 'operator'; actor: string },
): Promise<void> {
  await m.query(
    `UPDATE conversations
        SET control = 'bot', human_until = NULL, control_reason = NULL, updated_at = now()
      WHERE id = $1`,
    [a.conversationId],
  );
  // El dueño pudo haber intervenido a mitad de una captura: retomar ese paso
  // sería absurdo. El siguiente mensaje abre una sesión nueva desde el inicio.
  await m.query(
    `UPDATE conversation_sessions SET status = 'ended', updated_at = now()
      WHERE conversation_id = $1 AND status <> 'ended'`,
    [a.conversationId],
  );
  await recordAudit(m, {
    tenantId: a.tenantId, actor: a.actor, action: 'control.to_bot',
    conversationId: a.conversationId, details: { cause: a.cause },
  });
}
