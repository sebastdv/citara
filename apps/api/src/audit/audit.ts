import type { EntityManager } from 'typeorm';

export interface AuditEntry {
  tenantId: string;
  /** Quién: 'phone', 'flow', 'history', 'system', 'meta', 'operator:<id>'. */
  actor: string;
  /** Qué, con punto como separador: 'control.to_human', 'channel.disconnected'. */
  action: string;
  conversationId?: string | null;
  details?: Record<string, unknown>;
}

/** Única forma de escribir en audit_log. Solo inserción: la app no tiene UPDATE ni DELETE. */
export async function recordAudit(m: EntityManager, e: AuditEntry): Promise<void> {
  await m.query(
    `INSERT INTO audit_log (tenant_id, actor, action, conversation_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [e.tenantId, e.actor, e.action, e.conversationId ?? null, JSON.stringify(e.details ?? {})],
  );
}
