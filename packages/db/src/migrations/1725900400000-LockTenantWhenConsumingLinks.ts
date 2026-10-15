import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Consumir un enlace de conexión leía el estado del negocio sin bloquear su
 * fila: un `tenant suspend` todavía sin confirmar no se veía, y el enlace se
 * gastaba (y el canal o la cuenta de Google quedaban conectados) en un negocio
 * que acababa de quedar suspendido. Ahora ambas funciones toman la fila
 * antes de mirar el estado. CREATE OR REPLACE conserva los GRANT.
 */
export class LockTenantWhenConsumingLinks1725900400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION register_channel(
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
        -- Primero la fila del negocio: una suspensión en curso termina antes de
        -- que se lea su estado, y un negocio recién suspendido no gasta el enlace.
        -- FOR UPDATE y no FOR SHARE: refresh_tenant_status la pide FOR UPDATE en
        -- la misma transacción, y dos pestañas con FOR SHARE se trabarían.
        PERFORM 1 FROM public.tenants
         WHERE id = NULLIF(current_setting('app.tenant_id', true), '')::uuid FOR UPDATE;
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
      CREATE OR REPLACE FUNCTION consume_google_link(p_link uuid)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_resource uuid;
      BEGIN
        -- Primero la fila del negocio: una suspensión en curso termina antes de
        -- que se lea su estado, y un negocio recién suspendido no gasta el enlace.
        -- FOR UPDATE y no FOR SHARE: refresh_tenant_status la pide FOR UPDATE en
        -- la misma transacción, y dos pestañas con FOR SHARE se trabarían.
        PERFORM 1 FROM public.tenants
         WHERE id = NULLIF(current_setting('app.tenant_id', true), '')::uuid FOR UPDATE;
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
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION register_channel(
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
      CREATE OR REPLACE FUNCTION consume_google_link(p_link uuid)
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
  }
}
