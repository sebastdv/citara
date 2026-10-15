import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { DataSource } from 'typeorm';
import { EncryptionService } from '../crypto/encryption.service';
import { GoogleClient, REQUIRED_CALENDAR_SCOPES } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import { attachNewCalendar } from './accounts';
import { peekLink } from '../onboarding/links';
import { LinkInvalidError, OnboardingInputError } from '../onboarding/onboarding.service';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';

/** Lo que lanza consume_google_link cuando el enlace no está vigente. */
const LINK_INVALID_SQLSTATE = 'CT410';

@Injectable()
export class GoogleConnectService {
  private readonly log = new Logger(GoogleConnectService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly enc: EncryptionService,
    private readonly google: GoogleClient,
    private readonly tokens: GoogleTokens,
  ) {}

  async complete(input: { token: string; code: string }) {
    const link = await peekLink(this.ds, input.token, 'google');
    if (!link?.resourceId) throw new LinkInvalidError();

    const ex = await this.google.exchangeCode(input.code);
    // El consentimiento granular deja desmarcar permisos: sin los de calendario no hay integración.
    // Lo que Google ya emitió se revoca: no se va a usar, y no debe quedar vivo en su cuenta.
    if (REQUIRED_CALENDAR_SCOPES.some((s) => !ex.scopes.includes(s))) {
      await this.google.revokeToken(ex.refreshToken ?? ex.accessToken);
      throw new OnboardingInputError(
        'Para conectar el calendario hay que aceptar todos los permisos que pide Google. ' +
        'Vuelve a abrir el enlace y marca todas las casillas.');
    }
    if (!ex.refreshToken) {
      await this.google.revokeToken(ex.accessToken);
      throw new OnboardingInputError('Google no entregó un acceso permanente. Vuelve a abrir el enlace e inténtalo de nuevo.');
    }

    const { timezone, old } = await runInTenant(this.ds, link.tenantId, async (m) => {
      const [t] = await m.query(`SELECT timezone FROM tenants WHERE id = $1`, [link.tenantId]);
      const [a] = await m.query(
        `SELECT id, email, calendar_id, refresh_token_encrypted, watch_channel_id, watch_resource_id
           FROM google_accounts WHERE resource_id = $1`, [link.resourceId]);
      return { timezone: t.timezone as string, old: a as PreviousAccount | undefined };
    });
    const previous = old?.calendar_id ?? null;
    // Misma cuenta y calendario intacto: se reutiliza. Otra cuenta, o lo borró: uno nuevo.
    const reuse = previous ? await this.google.calendarExists(ex.accessToken, previous) : false;

    let accountId: string;
    try {
      accountId = await runInTenant(this.ds, link.tenantId, async (m) => {
        const [{ r: resourceId }] = await m.query(`SELECT consume_google_link($1) AS r`, [link.linkId]);
        const [acc] = await m.query(
          `INSERT INTO google_accounts
             (tenant_id, resource_id, email, calendar_id, refresh_token_encrypted, status, last_checked_at)
           VALUES ($1, $2, $3, $4, $5, 'active', now())
           ON CONFLICT (resource_id) DO UPDATE
             SET email = EXCLUDED.email, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                 status = 'active', calendar_id = EXCLUDED.calendar_id, last_checked_at = now(), updated_at = now()
           RETURNING id`,
          [link.tenantId, resourceId, ex.email, reuse ? previous : null, this.enc.encrypt(ex.refreshToken!)]);
        // Con el calendario reutilizado, lo que quedó sin subir mientras la cuenta
        // estuvo caída se vuelve a encolar con versión nueva: el jobId
        // push-<cita>-<versión> anterior ya completó (se saltó) y BullMQ ignoraría
        // el mismo id durante horas. Con calendario nuevo lo hace attachNewCalendar.
        if (reuse) await m.query(
          `UPDATE appointments SET google_sync_status = 'pending', google_sync_version = google_sync_version + 1
            WHERE resource_id = $1 AND google_sync_status IN ('none', 'pending', 'failed') AND ends_at > now()`,
          [resourceId]);
        await recordAudit(m, { tenantId: link.tenantId, actor: 'onboarding', action: 'calendar.connected',
                               details: { resourceId, email: ex.email } });
        return acc.id as string;
      });
    } catch (err) {
      if ((err as { driverError?: { code?: string } }).driverError?.code === LINK_INVALID_SQLSTATE) {
        throw new LinkInvalidError();
      }
      throw err;
    }
    // La renovación del token se hace con el refresh token nuevo.
    this.tokens.invalidate(accountId);
    // Sin esperar: es limpieza, y la respuesta ya espera bastante a Google.
    if (old && !reuse) void this.closePrevious(old, ex.email);

    let calendar: 'reused' | 'created' | 'pending' = 'reused';
    if (!reuse) {
      try {
        await attachNewCalendar(this.ds, this.google, ex.accessToken, {
          id: accountId, tenantId: link.tenantId, resourceId: link.resourceId,
          resourceName: link.resourceName ?? 'recurso', timezone });
        calendar = 'created';
      } catch (err) {
        // La conexión ya quedó: el chequeo de salud crea el calendario después.
        this.log.warn(`no se pudo crear el calendario de ${link.resourceId}: ${(err as Error).message}`);
        calendar = 'pending';
      }
    }
    return { resourceName: link.resourceName ?? 'el recurso', email: ex.email, calendar };
  }

  /**
   * Lo de la conexión anterior que ya no se va a usar: su canal de avisos (que
   * seguiría disparando lecturas) y, si era otra cuenta de Google, su calendario
   * "Citas" (que quedaría mostrando citas viejas) y su autorización. Con la
   * misma cuenta no se revoca nada: revocar mataría también el token nuevo.
   */
  async closePrevious(old: PreviousAccount, newEmail: string | null): Promise<void> {
    const ref = { id: `${old.id}:anterior`, refreshTokenEncrypted: old.refresh_token_encrypted };
    const otherAccount = !!old.email && !!newEmail && old.email.toLowerCase() !== newEmail.toLowerCase();
    try {
      await this.tokens.withToken(ref, async (t) => {
        if (old.watch_channel_id && old.watch_resource_id) {
          await this.google.stopChannel(t, old.watch_channel_id, old.watch_resource_id);
        }
        if (otherAccount && old.calendar_id) await this.google.deleteCalendar(t, old.calendar_id);
      });
      if (otherAccount) await this.google.revokeToken(this.enc.decrypt(old.refresh_token_encrypted));
    } catch (err) {
      // La cuenta anterior pudo quedar revocada: no hay con qué limpiar, y no es grave.
      this.log.warn(`no se pudo cerrar la conexión anterior de la cuenta ${old.id}: ${(err as Error).message}`);
    } finally {
      this.tokens.invalidate(ref.id);
    }
  }
}

interface PreviousAccount {
  id: string; email: string | null; calendar_id: string | null; refresh_token_encrypted: Buffer;
  watch_channel_id: string | null; watch_resource_id: string | null;
}
