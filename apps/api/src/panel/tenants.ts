import type { DataSource } from 'typeorm';

export interface PanelTenant { id: string; slug: string; name: string; timezone: string; status: string }

/** `tenants` no lleva RLS: el panel la lee sin contexto para saber por qué negocios pasar. */
export function panelTenants(ds: DataSource): Promise<PanelTenant[]> {
  return ds.query(`SELECT id, slug, name, timezone, status FROM tenants ORDER BY slug`);
}

export async function tenantBySlug(ds: DataSource, slug: string): Promise<PanelTenant | null> {
  const [t] = await ds.query(`SELECT id, slug, name, timezone, status FROM tenants WHERE slug = $1`, [slug]);
  return t ?? null;
}
