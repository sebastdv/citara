import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: OnboardingService es @Injectable() y Nest los resuelve por tipo.
import { DataSource } from 'typeorm';
import { EncryptionService } from '../crypto/encryption.service';
import { MetaOnboardingClient, type SyncType } from './meta-onboarding.client';
import { peekLink } from './links';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';

/** El enlace no existe, venció, ya se usó o es de un negocio suspendido. */
export class LinkInvalidError extends Error {
  constructor() { super('Este enlace ya no es válido'); }
}

/** Lo que mandó la página no alcanza para completar el alta. */
export class OnboardingInputError extends Error {}

/** El número ya está conectado a otro negocio: register_channel no lo cambia de dueño. */
export class PhoneTakenError extends Error {
  constructor() {
    super('Este número de WhatsApp ya está conectado a otro negocio. Escríbele a quien te envió este enlace para revisarlo.');
  }
}

export const SYNC_TYPES: SyncType[] = ['smb_app_state_sync', 'history'];
/** Lo que lanza register_channel cuando el enlace no está vigente, y cuando el número es de otro negocio. */
const LINK_INVALID_SQLSTATE = 'CT410';
const PHONE_TAKEN_SQLSTATE = 'CT409';

@Injectable()
export class OnboardingService {
  private readonly log = new Logger(OnboardingService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly enc: EncryptionService,
    private readonly meta: MetaOnboardingClient,
  ) {}

  async completeWhatsapp(input: { token: string; code: string; wabaId: string; phoneNumberId?: string | null }) {
    // Antes de hablar con Meta: un enlace inválido no gasta el código del cliente.
    const link = await peekLink(this.ds, input.token, 'whatsapp');
    if (!link) throw new LinkInvalidError();

    const accessToken = await this.meta.exchangeCode(input.code);
    const phones = await this.meta.phoneNumbers(input.wabaId, accessToken);
    const phone = input.phoneNumberId
      ? phones.find((p) => p.id === input.phoneNumberId)
      : phones.length === 1 ? phones[0] : undefined;
    if (!phone) {
      throw new OnboardingInputError(phones.length === 0
        ? 'La cuenta de WhatsApp no tiene números'
        : 'Tu cuenta de WhatsApp Business tiene varios números y Meta no indicó cuál conectar. ' +
          'Escríbele a quien te envió este enlace para conectarlo con el número correcto.');
    }
    await this.meta.subscribeApp(input.wabaId, accessToken);

    // register_channel consume el enlace y registra el canal en la misma
    // sentencia: si dos pestañas completan a la vez, solo una gana y la otra
    // no deja un canal a medias. Sin enlace vigente, la función no registra nada.
    let channelId: string;
    try {
      channelId = await runInTenant(this.ds, link.tenantId, async (m) => {
        const [row] = await m.query(
          `SELECT register_channel($1, $2, $3, $4, $5, 'coexistence') AS id`,
          [link.linkId, input.wabaId, phone.id, phone.displayPhoneNumber, this.enc.encrypt(accessToken)]);
        await recordAudit(m, {
          tenantId: link.tenantId, actor: 'onboarding', action: 'channel.connected',
          details: { channelId: row.id, phoneNumberId: phone.id, mode: 'coexistence' },
        });
        await m.query(`SELECT refresh_tenant_status($1)`, [link.tenantId]);
        return row.id as string;
      });
    } catch (err) {
      const code = (err as { driverError?: { code?: string } }).driverError?.code;
      if (code === LINK_INVALID_SQLSTATE) throw new LinkInvalidError();
      if (code === PHONE_TAKEN_SQLSTATE) throw new PhoneTakenError();
      throw err;
    }

    // Fuera de la transacción y sin esperarlas: son dos llamadas más a Meta y el
    // cliente ya tiene su número conectado. Un fallo no deshace el alta; queda en
    // la bitácora y el operador lo reintenta con `pnpm tenant sync` dentro de las 24 h.
    const syncs = this.requestSyncs(link.tenantId, phone.id, accessToken).catch((err: Error) => {
      this.log.warn(`no se pudieron registrar las sincronizaciones de ${phone.id}: ${err.message}`);
      return {} as Partial<Record<SyncType, 'requested' | 'failed'>>;
    });
    return { tenantId: link.tenantId, channelId, phoneNumberId: phone.id,
             displayPhoneNumber: phone.displayPhoneNumber, syncs };
  }

  /** Contactos e historial. Meta acepta cada uno una sola vez, dentro de 24 h del alta. */
  async requestSyncs(tenantId: string, phoneNumberId: string, accessToken: string, types: SyncType[] = SYNC_TYPES) {
    const out = {} as Partial<Record<SyncType, 'requested' | 'failed'>>;
    for (const syncType of types) {
      try {
        await this.meta.requestSync(phoneNumberId, accessToken, syncType);
        out[syncType] = 'requested';
      } catch (err) {
        out[syncType] = 'failed';
        this.log.warn(`no se pudo pedir ${syncType} para ${phoneNumberId}: ${(err as Error).message}`);
      }
      await runInTenant(this.ds, tenantId, (m) => recordAudit(m, {
        tenantId, actor: 'onboarding',
        action: out[syncType] === 'requested' ? 'channel.sync_requested' : 'channel.sync_failed',
        details: { syncType, phoneNumberId },
      }));
    }
    return out;
  }
}
