import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los enlaces de Google son por recurso (spec §8 paso 4). Consumirlos pasa por
 * una función SECURITY DEFINER, como register_channel: la app no tiene UPDATE
 * sobre onboarding_links. Endurecida desde el inicio (pg_temp al final, nombres
 * calificados, ligada al negocio de la transacción).
 */
export class AddResourceToOnboardingLinks1725600100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE onboarding_links ADD COLUMN resource_id uuid REFERENCES resources(id) ON DELETE CASCADE`);
    await q.query(`
      ALTER TABLE onboarding_links ADD CONSTRAINT onboarding_links_google_resource_check
        CHECK (purpose <> 'google' OR resource_id IS NOT NULL)
    `);
    await q.query(`
      CREATE FUNCTION consume_google_link(p_link uuid)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_resource uuid;
      BEGIN
        UPDATE public.onboarding_links l SET used_at = now()
          FROM public.tenants t
         WHERE l.id = p_link AND t.id = l.tenant_id AND l.purpose = 'google'
           AND l.used_at IS NULL AND l.expires_at > now() AND t.status <> 'suspended'
           AND l.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        RETURNING l.resource_id INTO v_resource;
        IF v_resource IS NULL THEN
          RAISE EXCEPTION 'el enlace de conexión no es válido' USING ERRCODE = 'CT410';
        END IF;
        RETURN v_resource;
      END $$
    `);
    await q.query(`REVOKE ALL ON FUNCTION consume_google_link(uuid) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION consume_google_link(uuid) TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION consume_google_link(uuid)`);
    await q.query(`ALTER TABLE onboarding_links DROP CONSTRAINT onboarding_links_google_resource_check`);
    await q.query(`ALTER TABLE onboarding_links DROP COLUMN resource_id`);
  }
}
