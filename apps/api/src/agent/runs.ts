import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { PRICING, usdFor, type Usage } from './pricing';

export interface RunRecord {
  tenantId: string; conversationId: string | null; inboundMessageId: string | null;
  kind: 'agent' | 'interpret'; model: string; configVersion: number | null; usage: Usage | null;
  /** El modelo pedido: si el que respondió (un fallback) no tiene precio, se cobra a este. */
  priceModel?: string;
  latencyMs: number; tools: string[]; stopReason: string | null; error: string | null;
}

/** Una fila por llamada al modelo, en su propia transacción: el costo queda aunque el turno falle. */
export async function recordRun(ds: DataSource, r: RunRecord): Promise<number> {
  const usd = r.usage ? costOf(r) : 0;
  await runInTenant(ds, r.tenantId, (m) => m.query(
    `INSERT INTO agent_runs (tenant_id, conversation_id, inbound_message_id, kind, model, config_version,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd,
                             latency_ms, tools, stop_reason, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [r.tenantId, r.conversationId, r.inboundMessageId, r.kind, r.model, r.configVersion,
     r.usage?.input_tokens ?? 0, r.usage?.output_tokens ?? 0, r.usage?.cache_read_input_tokens ?? 0,
     r.usage?.cache_creation_input_tokens ?? 0, usd, r.latencyMs, r.tools, r.stopReason, r.error]));
  return usd;
}

/**
 * La contabilidad no puede romper un turno que ya salió bien: un modelo sin
 * precio se cobra al del modelo pedido y, si tampoco lo hay, al más caro.
 */
function costOf(r: RunRecord): number {
  for (const model of [r.model, r.priceModel]) {
    if (model && PRICING[model]) return usdFor(model, r.usage!);
  }
  const priciest = Object.keys(PRICING).sort((a, b) => PRICING[b].output - PRICING[a].output)[0];
  console.warn(`[agent] sin precio para ${r.model}: se cobra como ${priciest}`);
  return usdFor(priciest, r.usage!);
}
