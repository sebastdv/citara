/** SQL reutilizable: activa RLS tenant-scoped sobre una tabla. */
export function tenantRlsSql(table: string): string[] {
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    // FORCE es indispensable: sin él, el dueño de la tabla salta la política.
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    // NULLIF envuelve current_setting: tras un COMMIT, un GUC personalizado
    // que nunca se fijó a nivel de sesión (solo vía SET LOCAL) revierte a ''
    // en vez de NULL, y '' ::uuid lanza una excepción en lugar de fallar
    // cerrado con cero filas. NULLIF(..., '') normaliza '' a NULL primero.
    `CREATE POLICY tenant_isolation ON ${table}
       USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO citara_app`,
  ];
}
