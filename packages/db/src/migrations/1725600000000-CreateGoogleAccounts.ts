import type { MigrationInterface, QueryRunner } from 'typeorm';
import { tenantRlsSql } from '../rls.ts';

/**
 * La conexión de un recurso con su Google Calendar (spec §4.1). Una por
 * recurso. `calendar_id` es el calendario "Citas" que crea la app (permiso
 * calendar.app.created); el principal solo se consulta como ocupado.
 * Tenant-scoped con RLS; la app no borra cuentas (reconectar actualiza).
 */
export class CreateGoogleAccounts1725600000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE google_accounts (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id             uuid NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
        email                   varchar(320),
        calendar_id             varchar(1024),
        refresh_token_encrypted bytea NOT NULL,
        status                  varchar(16) NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'needs_reauth')),
        sync_token              text,
        last_pulled_at          timestamptz,
        last_checked_at         timestamptz,
        watch_channel_id        uuid,
        watch_resource_id       text,
        watch_token_hash        char(64),
        watch_expires_at        timestamptz,
        watch_error             text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const sql of tenantRlsSql('google_accounts')) await q.query(sql);
    await q.query(`REVOKE DELETE ON google_accounts FROM citara_app`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE google_accounts`);
  }
}
