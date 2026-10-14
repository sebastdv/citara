import { adminQuery } from '../helpers';

/** Un negocio activo con su canal. `phone` es también el phone_number_id. */
export async function seedBiz(slug: string, phone: string, mode: 'cloud_api' | 'coexistence' = 'cloud_api') {
  const [t] = await adminQuery(
    `INSERT INTO tenants (slug, name, timezone, status) VALUES ($1, $2, 'America/Bogota', 'active') RETURNING id`,
    [slug, `Negocio ${slug.toUpperCase()}`]);
  const [ch] = await adminQuery(
    `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted, mode)
     VALUES ($1, $2, $2, '\\x00', $3) RETURNING id`, [t.id, phone, mode]);
  return { tenantId: t.id as string, channelId: ch.id as string };
}

export async function seedConv(
  b: { tenantId: string; channelId: string }, waId: string,
  over: { control?: 'bot' | 'human'; until?: string; reason?: string; lastInboundAt?: string } = {},
): Promise<string> {
  const [ct] = await adminQuery(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1, $2, 'Perfil') RETURNING id`, [b.tenantId, waId]);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, control, human_until, control_reason, last_inbound_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [b.tenantId, ct.id, b.channelId, over.control ?? 'bot', over.until ?? null, over.reason ?? null,
     over.lastInboundAt ?? new Date().toISOString()]);
  return c.id;
}

export function msg(
  tenantId: string, conversationId: string, at: string,
  p: Partial<{ direction: 'in' | 'out'; origin: string; body: string | null; payload: object; status: string; type: string }> = {},
) {
  return adminQuery(
    `INSERT INTO messages (tenant_id, conversation_id, direction, origin, type, body, payload, status, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [tenantId, conversationId, p.direction ?? 'in', p.origin ?? 'customer', p.type ?? 'text',
     p.body === undefined ? 'hola' : p.body, p.payload ? JSON.stringify(p.payload) : null, p.status ?? null, at]);
}
