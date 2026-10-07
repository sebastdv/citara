import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Endurece las funciones SECURITY DEFINER del alta:
 *
 * 1. pg_temp. Con `search_path = public`, Postgres busca PRIMERO en el esquema
 *    temporal de la sesión: la app podía crear una tabla temporal
 *    `whatsapp_channels` con un trigger y ejecutarlo como el dueño de la
 *    función (superusuario). Se fija `pg_temp` al final, se califican los
 *    nombres y la app pierde el privilegio de crear objetos temporales.
 * 2. register_channel aceptaba cualquier negocio: con la app comprometida se
 *    podía reescribir el token de cualquier cliente. Ahora exige un enlace de
 *    conexión vigente del negocio y lo consume en la misma sentencia, así que
 *    la app ya no necesita (ni tiene) UPDATE sobre onboarding_links.
 */
export class HardenOnboardingFunctions1725500300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, citara_app', current_database());
      END $$
    `);
    await q.query(`REVOKE UPDATE (used_at) ON onboarding_links FROM citara_app`);

    await q.query(`DROP FUNCTION register_channel(uuid, text, text, text, bytea, text)`);
    await q.query(`
      CREATE FUNCTION register_channel(
        p_link uuid, p_waba text, p_phone text, p_display text, p_token bytea, p_mode text
      ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_tenant uuid; v_id uuid;
      BEGIN
        IF p_mode NOT IN ('cloud_api', 'coexistence') THEN
          RAISE EXCEPTION 'modo de canal inválido: %', p_mode;
        END IF;
        -- Consumir el enlace es el permiso: sin uno vigente del negocio en
        -- cuyo contexto corre la transacción (app.tenant_id), nada. De dos
        -- llamadas con el mismo enlace, la segunda espera el lock de la fila y,
        -- al ver used_at puesto, no encuentra nada.
        UPDATE public.onboarding_links l SET used_at = now()
          FROM public.tenants t
         WHERE l.id = p_link AND t.id = l.tenant_id AND l.purpose = 'whatsapp'
           AND l.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           AND l.used_at IS NULL AND l.expires_at > now() AND t.status <> 'suspended'
        RETURNING l.tenant_id INTO v_tenant;
        IF v_tenant IS NULL THEN
          RAISE EXCEPTION 'el enlace de conexión no es válido' USING ERRCODE = 'CT410';
        END IF;
        -- El WHERE del DO UPDATE impide que un número cambie de dueño: si es de
        -- otro negocio no se actualiza nada, no vuelve id y se aborta.
        INSERT INTO public.whatsapp_channels
          (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted, mode, history_sync, status)
        VALUES (v_tenant, p_waba, p_phone, p_display, p_token, p_mode,
                CASE WHEN p_mode = 'coexistence' THEN 'pending' ELSE 'not_applicable' END, 'active')
        ON CONFLICT (phone_number_id) DO UPDATE
          SET waba_id = EXCLUDED.waba_id, display_phone_number = EXCLUDED.display_phone_number,
              access_token_encrypted = EXCLUDED.access_token_encrypted, mode = EXCLUDED.mode,
              history_sync = EXCLUDED.history_sync, status = 'active'
          WHERE public.whatsapp_channels.tenant_id = EXCLUDED.tenant_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN
          RAISE EXCEPTION 'el número % ya pertenece a otro negocio', p_phone USING ERRCODE = 'CT409';
        END IF;
        RETURN v_id;
      END $$
    `);
    await q.query(`
      CREATE OR REPLACE FUNCTION refresh_tenant_status(p_tenant uuid)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_status text; v_ready boolean;
      BEGIN
        SELECT status INTO v_status FROM public.tenants WHERE id = p_tenant FOR UPDATE;
        IF v_status IS NULL THEN RAISE EXCEPTION 'no existe el negocio %', p_tenant; END IF;
        -- Solo el alta avanza sola. Un suspendido lo reactiva el operador.
        IF v_status <> 'onboarding' THEN RETURN v_status; END IF;
        SELECT EXISTS (SELECT 1 FROM public.whatsapp_channels WHERE tenant_id = p_tenant AND status = 'active')
           AND EXISTS (SELECT 1 FROM public.services WHERE tenant_id = p_tenant AND active)
           AND EXISTS (SELECT 1 FROM public.business_hours WHERE tenant_id = p_tenant)
           AND EXISTS (SELECT 1 FROM public.flows WHERE tenant_id = p_tenant AND is_active AND is_default)
          INTO v_ready;
        IF NOT v_ready THEN RETURN 'onboarding'; END IF;
        UPDATE public.tenants SET status = 'active' WHERE id = p_tenant;
        RETURN 'active';
      END $$
    `);
    await q.query(`REVOKE ALL ON FUNCTION register_channel(uuid, text, text, text, bytea, text) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION register_channel(uuid, text, text, text, bytea, text) TO citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Vuelve a la firma anterior (p_tenant) con el search_path endurecido: no
    // se reintroduce el agujero de pg_temp al bajar.
    await q.query(`DROP FUNCTION register_channel(uuid, text, text, text, bytea, text)`);
    await q.query(`
      CREATE FUNCTION register_channel(
        p_tenant uuid, p_waba text, p_phone text, p_display text, p_token bytea, p_mode text
      ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_id uuid;
      BEGIN
        INSERT INTO public.whatsapp_channels
          (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted, mode, history_sync, status)
        VALUES (p_tenant, p_waba, p_phone, p_display, p_token, p_mode,
                CASE WHEN p_mode = 'coexistence' THEN 'pending' ELSE 'not_applicable' END, 'active')
        ON CONFLICT (phone_number_id) DO UPDATE
          SET waba_id = EXCLUDED.waba_id, display_phone_number = EXCLUDED.display_phone_number,
              access_token_encrypted = EXCLUDED.access_token_encrypted, mode = EXCLUDED.mode,
              history_sync = EXCLUDED.history_sync, status = 'active'
          WHERE public.whatsapp_channels.tenant_id = EXCLUDED.tenant_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'el número % ya pertenece a otro negocio', p_phone; END IF;
        RETURN v_id;
      END $$
    `);
    await q.query(`REVOKE ALL ON FUNCTION register_channel(uuid, text, text, text, bytea, text) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION register_channel(uuid, text, text, text, bytea, text) TO citara_app`);
    await q.query(`GRANT UPDATE (used_at) ON onboarding_links TO citara_app`);
    await q.query(`
      DO $$ BEGIN
        EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
      END $$
    `);
  }
}
