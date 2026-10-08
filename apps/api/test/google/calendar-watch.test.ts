import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { hashToken } from '../../src/onboarding/links';
import { GoogleApiError } from '../../src/google/google.client';
import { CalendarWatchService } from '../../src/google/calendar-watch.service';
import { resetDb, seedChannel, seedCatalog, seedGoogleAccount, adminQuery, closeHelpers } from '../helpers';

let app: DataSource;
let tenantId: string, accountId: string;
let google: Record<'watchEvents' | 'stopChannel', ReturnType<typeof vi.fn>>;
let watch: CalendarWatchService;

const AHORA = new Date('2026-09-08T12:00:00Z');
const EXPIRA = new Date('2026-10-08T12:00:00Z');
const renew = () => watch.renew({ tenantId, accountId }, AHORA);

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  process.env.PUBLIC_BASE_URL = 'https://citara.test';
  await resetDb();
  ({ tenantId } = await seedChannel());
  const { resourceId } = await seedCatalog(tenantId);
  accountId = await seedGoogleAccount(tenantId, resourceId);
  google = { watchEvents: vi.fn().mockResolvedValue({ resourceId: 'RID', expiration: EXPIRA }),
             stopChannel: vi.fn().mockResolvedValue(undefined) };
  const tokens = { withToken: (_a: unknown, fn: (t: string) => unknown) => fn('ya29.prueba') };
  watch = new CalendarWatchService(app, tokens as never, google as never);
});
afterEach(() => { process.env.PUBLIC_BASE_URL = 'http://localhost:3000'; });

describe('CalendarWatchService', () => {
  it('abre un canal hacia /webhooks/google y guarda solo el hash del secreto', async () => {
    expect(await renew()).toBe('renewed');
    const [, cal, ch] = google.watchEvents.mock.calls[0];
    expect(cal).toBe('citas123@group.calendar.google.com');
    expect(ch.address).toBe('https://citara.test/webhooks/google');
    const [prefix, secret] = ch.token.split('.');
    expect(prefix).toBe(tenantId);
    const [acc] = await adminQuery(`SELECT watch_channel_id, watch_resource_id, watch_token_hash, watch_expires_at FROM google_accounts`);
    expect(acc).toMatchObject({ watch_channel_id: ch.id, watch_resource_id: 'RID', watch_token_hash: hashToken(secret) });
    expect(new Date(acc.watch_expires_at).toISOString()).toBe(EXPIRA.toISOString());
  });

  it('al renovar cierra el canal anterior', async () => {
    await renew();
    const [{ watch_channel_id: viejo }] = await adminQuery(`SELECT watch_channel_id FROM google_accounts`);
    await adminQuery(`UPDATE google_accounts SET watch_expires_at = $1`, [new Date('2026-09-09T00:00:00Z')]);
    await renew();
    expect(google.stopChannel).toHaveBeenCalledWith('ya29.prueba', viejo, 'RID');
  });

  it('no renueva un canal que todavía tiene más de dos días', async () => {
    await renew();
    expect(await renew()).toBe('skipped');
    expect(google.watchEvents).toHaveBeenCalledTimes(1);
  });

  it('sin HTTPS no hay canal: quedan los sondeos cada 15 minutos', async () => {
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    expect(await renew()).toBe('skipped');
    expect(google.watchEvents).not.toHaveBeenCalled();
  });

  it('si falla, lo deja visible y lo audita una vez, no en cada intento', async () => {
    google.watchEvents.mockRejectedValue(new GoogleApiError('apertura del canal de avisos: Google respondió 400', 400));
    await expect(renew()).rejects.toThrow(/400/);
    await expect(renew()).rejects.toThrow(/400/);
    expect((await adminQuery(`SELECT watch_error FROM google_accounts`))[0].watch_error).toMatch(/400/);
    expect(await adminQuery(`SELECT action FROM audit_log`)).toEqual([{ action: 'calendar.watch_failed' }]);
  });
});
