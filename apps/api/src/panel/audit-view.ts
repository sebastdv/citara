import type { DataSource } from 'typeorm';
import { runInTenant } from '../tenancy/tenant-context';
import { panelTenants, type PanelTenant } from './tenants';
import { byRecent, exactAt, PAGE_SIZE, type Cursor } from './inbox';

export interface AuditRow {
  tenant: PanelTenant; id: string; at: Date; cursorAt: string; actor: string; action: string;
  conversationId: string | null; details: Record<string, unknown>;
}

export interface AuditFilter { slug?: string; action?: string; conversationId?: string; before?: Cursor }

/** Prefijo literal: `%` y `_` no son comodines aquí. */
const likePrefix = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';

/** `audit_log` de todos los negocios, cada uno en su contexto de RLS. */
export async function loadAudit(ds: DataSource, f: AuditFilter): Promise<{ rows: AuditRow[]; next: Cursor | null }> {
  const tenants = (await panelTenants(ds)).filter((t) => !f.slug || t.slug === f.slug);
  const all: AuditRow[] = [];
  for (const tenant of tenants) {
    const rows: any[] = await runInTenant(ds, tenant.id, (m) => m.query(
      `SELECT id, created_at, ${exactAt('created_at')} AS cursor_at, actor, action, conversation_id, details
         FROM audit_log
        WHERE ($1::text IS NULL OR action LIKE $1)
          AND ($2::uuid IS NULL OR conversation_id = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [f.action ? likePrefix(f.action) : null, f.conversationId ?? null, f.before?.at ?? null,
       f.before?.id ?? null, PAGE_SIZE + 1]));
    for (const r of rows) {
      all.push({ tenant, id: r.id, at: r.created_at, cursorAt: r.cursor_at, actor: r.actor, action: r.action,
                 conversationId: r.conversation_id, details: r.details });
    }
  }
  all.sort((a, b) => byRecent({ at: a.cursorAt, id: a.id }, { at: b.cursorAt, id: b.id }));
  const rows = all.slice(0, PAGE_SIZE);
  const last = rows[rows.length - 1];
  return { rows, next: all.length > PAGE_SIZE ? { at: last.cursorAt, id: last.id } : null };
}
