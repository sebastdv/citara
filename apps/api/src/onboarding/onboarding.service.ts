import { Injectable, Logger } from '@nestjs/common';
// Imports de VALOR: OnboardingService es @Injectable() y Nest los resuelve por tipo.
import { DataSource } from 'typeorm';
import { EncryptionService } from '../crypto/encryption.service';
import { MetaOnboardingClient, type SyncType } from './meta-onboarding.client';
import { consumeLink, peekLink } from './links';
import { runInTenant } from '../tenancy/tenant-context';
import { recordAudit } from '../audit/audit';

/** El enlace no existe, venció, ya se usó o es de un negocio suspendido. */
export class LinkInvalidError extends Error {
  constructor() { super('Este enlace ya no es válido'); }
}

/** Lo que mandó la página no alcanza para completar el alta. */
export class OnboardingInputError extends Error {}

const SYNC_TYPES: SyncType[] = ['smb_app_state_sync', 'history'];

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
        : 'La cuenta tiene varios números y no se indicó cuál conectar');
    }
    await this.meta.subscribeApp(input.wabaId, accessToken);

    // Consumir el enlace y registrar el canal van juntos: si dos pestañas
    // completan a la vez, solo una gana y la otra no deja un canal a medias.
    const channelId = await runInTenant(this.ds, link.tenantId, async (m) => {
      if (!(await consumeLink(m, link.linkId))) throw new LinkInvalidError();
      const [row] = await m.query(
        `SELECT register_channel($1, $2, $3, $4, $5, 'coexistence') AS id`,
        [link.tenantId, input.wabaId, phone.id, phone.displayPhoneNumber, this.enc.encrypt(accessToken)]);
      await recordAudit(m, {
        tenantId: link.tenantId, actor: 'onboarding', action: 'channel.connected',
        details: { channelId: row.id, phoneNumberId: phone.id, mode: 'coexistence' },
      });
      await m.query(`SELECT refresh_tenant_status($1)`, [link.tenantId]);
      return row.id as string;
    });

    // Fuera de la transacción: son llamadas a Meta. Un fallo no deshace el alta;
    // el operador lo reintenta con `pnpm tenant sync` dentro de las 24 h.
    const syncs = await this.requestSyncs(link.tenantId, phone.id, accessToken);
    return { tenantId: link.tenantId, channelId, phoneNumberId: phone.id,
             displayPhoneNumber: phone.displayPhoneNumber, syncs };
  }

  /** Contactos e historial. Meta acepta cada uno una sola vez, dentro de 24 h del alta. */
  async requestSyncs(tenantId: string, phoneNumberId: string, accessToken: string) {
    const out = {} as Record<SyncType, 'requested' | 'failed'>;
    for (const syncType of SYNC_TYPES) {
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
