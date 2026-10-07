import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dos escrituras que el alta necesita y que la app NO puede hacer por su
 * cuenta (no tiene INSERT en whatsapp_channels ni UPDATE en tenants, y así
 * debe seguir). SECURITY DEFINER las ejecuta con los privilegios del dueño,
 * pero solo hacen exactamente esto, con la validación adentro.
 */
export class CreateOnboardingFunctions1725500200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION register_channel(
        p_tenant uuid, p_waba text, p_phone text, p_display text, p_token bytea, p_mode text
      ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_id uuid;
      BEGIN
        IF p_mode NOT IN ('cloud_api', 'coexistence') THEN
          RAISE EXCEPTION 'modo de canal inválido: %', p_mode;
        END IF;
        -- El WHERE del DO UPDATE impide que un número cambie de dueño: si es de
        -- otro negocio no se actualiza nada, no vuelve id y se aborta.
        INSERT INTO whatsapp_channels
          (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted, mode, history_sync, status)
        VALUES (p_tenant, p_waba, p_phone, p_display, p_token, p_mode,
                CASE WHEN p_mode = 'coexistence' THEN 'pending' ELSE 'not_applicable' END, 'active')
        ON CONFLICT (phone_number_id) DO UPDATE
          SET waba_id = EXCLUDED.waba_id, display_phone_number = EXCLUDED.display_phone_number,
              access_token_encrypted = EXCLUDED.access_token_encrypted, mode = EXCLUDED.mode,
              history_sync = EXCLUDED.history_sync, status = 'active'
          WHERE whatsapp_channels.tenant_id = EXCLUDED.tenant_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN
          RAISE EXCEPTION 'el número % ya pertenece a otro negocio', p_phone;
        END IF;
        RETURN v_id;
      END $$
    `);
    await q.query(`
      CREATE FUNCTION refresh_tenant_status(p_tenant uuid)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_status text; v_ready boolean;
      BEGIN
        SELECT status INTO v_status FROM tenants WHERE id = p_tenant FOR UPDATE;
        IF v_status IS NULL THEN RAISE EXCEPTION 'no existe el negocio %', p_tenant; END IF;
        -- Solo el alta avanza sola. Un suspendido lo reactiva el operador.
        IF v_status <> 'onboarding' THEN RETURN v_status; END IF;
        SELECT EXISTS (SELECT 1 FROM whatsapp_channels WHERE tenant_id = p_tenant AND status = 'active')
           AND EXISTS (SELECT 1 FROM services WHERE tenant_id = p_tenant AND active)
           AND EXISTS (SELECT 1 FROM business_hours WHERE tenant_id = p_tenant)
           AND EXISTS (SELECT 1 FROM flows WHERE tenant_id = p_tenant AND is_active AND is_default)
          INTO v_ready;
        IF NOT v_ready THEN RETURN 'onboarding'; END IF;
        UPDATE tenants SET status = 'active' WHERE id = p_tenant;
        RETURN 'active';
      END $$
    `);
    for (const fn of ['register_channel(uuid, text, text, text, bytea, text)', 'refresh_tenant_status(uuid)']) {
      await q.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await q.query(`GRANT EXECUTE ON FUNCTION ${fn} TO citara_app`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION refresh_tenant_status(uuid)`);
    await q.query(`DROP FUNCTION register_channel(uuid, text, text, text, bytea, text)`);
  }
}
