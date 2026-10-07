import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { createLink, hashToken, peekLink } from '../../src/onboarding/links';
import { resetDb, seedChannel, adminQuery, closeHelpers } from '../helpers';

let admin: DataSource, app: DataSource;
let tenantId: string;

beforeAll(async () => {
  admin = createDataSource(process.env.DATABASE_ADMIN_URL!); await admin.initialize();
  app = createDataSource(process.env.DATABASE_URL!); await app.initialize();
});
afterAll(async () => { await admin.destroy(); await app.destroy(); await closeHelpers(); });
beforeEach(async () => { await resetDb(); ({ tenantId } = await seedChannel()); });

describe('enlaces de conexión', () => {
  it('un enlace recién creado es válido para su propósito y trae el nombre del negocio', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    expect(await peekLink(app, token, 'whatsapp')).toMatchObject({ tenantId, tenantName: 'Salón X' });
    expect(await peekLink(app, token, 'google')).toBeNull();
  });

  it('solo se guarda el hash del token', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    const [row] = await adminQuery(`SELECT token_hash FROM onboarding_links`);
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toContain(token);
  });

  it('la aplicación no puede marcar ni revivir enlaces por su cuenta', async () => {
    // Usarlo es cosa de register_channel, en la misma transacción que el canal.
    await createLink(admin, tenantId, 'whatsapp');
    await expect(app.query(`UPDATE onboarding_links SET used_at = NULL`)).rejects.toThrow(/permission denied/);
  });

  it('un enlace vencido no sirve', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    await adminQuery(`UPDATE onboarding_links SET expires_at = now() - interval '1 minute'`);
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
  });

  it('un negocio suspendido no puede usar sus enlaces', async () => {
    const token = await createLink(admin, tenantId, 'whatsapp');
    await adminQuery(`UPDATE tenants SET status = 'suspended'`);
    expect(await peekLink(app, token, 'whatsapp')).toBeNull();
  });

  it('la aplicación no puede crear enlaces', async () => {
    await expect(app.query(
      `INSERT INTO onboarding_links (tenant_id, purpose, token_hash, expires_at) VALUES ($1, 'whatsapp', 'x', now())`,
      [tenantId])).rejects.toThrow(/permission denied/);
  });
});
