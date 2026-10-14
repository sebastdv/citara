import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { describeMessage } from './conversation';
import { panelTenants, type PanelTenant } from './tenants';

export const PAGE_SIZE = 50;

/**
 * Corte de página. `at` es el instante EXACTO en texto (microsegundos): un Date
 * de JS los pierde, y un cursor truncado se salta las filas del mismo milisegundo.
 */
export interface Cursor { at: string; id: string }

/** timestamptz → texto UTC de ancho fijo: ordenar el texto es ordenar el instante. */
export const exactAt = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface InboxRow {
  tenant: PanelTenant; conversationId: string; contactName: string | null; waId: string;
  mode: 'cloud_api' | 'coexistence'; control: 'bot' | 'human'; reason: string | null; humanUntil: Date | null;
  lastMessageAt: Date; lastDirection: 'in' | 'out' | null; lastPreview: string; cursorAt: string;
}

export interface InboxFilter { tab: 'traspasos' | 'todas'; slug?: string; before?: Cursor }

const SELECT = `
  SELECT c.id, c.control, c.human_until, c.control_reason, c.last_message_at, ${exactAt('c.last_message_at')} AS cursor_at,
         ct.wa_id, coalesce(ct.saved_name, ct.name) AS contact_name, ch.mode,
         lm.direction, lm.type, lm.body, lm.payload
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    JOIN whatsapp_channels ch ON ch.id = c.channel_id
    LEFT JOIN LATERAL (
      SELECT direction, type, body, payload FROM messages m
       WHERE m.conversation_id = c.id ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT 1) lm ON true`;

/** Más reciente primero; a igual instante, el mismo orden que `(at, id) DESC` en Postgres. */
export const byRecent = (a: Cursor, b: Cursor) =>
  (b.at > a.at ? 1 : b.at < a.at ? -1 : 0) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);

/**
 * La bandeja de todos los negocios, negocio por negocio con su contexto de
 * RLS (spec §3.7): una consulta que olvide el contexto devuelve cero filas,
 * no las de otro cliente.
 */
export async function loadInbox(
  ds: DataSource, f: InboxFilter, now = new Date(),
): Promise<{ rows: InboxRow[]; next: Cursor | null }> {
  const tenants = (await panelTenants(ds)).filter((t) => !f.slug || t.slug === f.slug);
  const all: InboxRow[] = [];
  for (const tenant of tenants) {
    const raw: any[] = await runInTenant(ds, tenant.id, (m) => (f.tab === 'traspasos'
      ? m.query(`${SELECT} WHERE c.control = 'human' AND c.human_until > $1 AND c.last_message_at IS NOT NULL`, [now])
      : m.query(`${SELECT}
          WHERE c.last_message_at IS NOT NULL
            AND ($1::timestamptz IS NULL OR (c.last_message_at, c.id) < ($1::timestamptz, $2::uuid))
          ORDER BY c.last_message_at DESC, c.id DESC LIMIT $3`,
          [f.before?.at ?? null, f.before?.id ?? null, PAGE_SIZE + 1])));
    for (const r of raw) {
      all.push({
        tenant, conversationId: r.id, contactName: r.contact_name, waId: r.wa_id, mode: r.mode,
        control: r.control, reason: r.control_reason, humanUntil: r.human_until, lastMessageAt: r.last_message_at,
        lastDirection: r.direction ?? null, lastPreview: r.direction ? describeMessage(r).slice(0, 140) : '',
        cursorAt: r.cursor_at,
      });
    }
  }
  const recent = (a: InboxRow, b: InboxRow) =>
    byRecent({ at: a.cursorAt, id: a.conversationId }, { at: b.cursorAt, id: b.conversationId });
  if (f.tab === 'traspasos') {
    // Primero donde nadie más va a contestar: número dedicado con el cliente esperando.
    const waiting = (r: InboxRow) => (r.mode === 'cloud_api' && r.lastDirection === 'in' ? 0 : 1);
    all.sort((a, b) => waiting(a) - waiting(b) || recent(a, b));
    return { rows: all, next: null };
  }
  all.sort(recent);
  const rows = all.slice(0, PAGE_SIZE);
  const last = rows[rows.length - 1];
  return { rows, next: all.length > PAGE_SIZE ? { at: last.cursorAt, id: last.conversationId } : null };
}
