import type { DataSource } from 'typeorm';
import type { EncryptionService } from '../crypto/encryption.service';

export interface ResolvedChannel {
  tenantId: string;
  channelId: string;
  wabaId: string;
  /** Necesario al enviar: el endpoint de Graph se construye con él. */
  phoneNumberId: string;
  accessToken: string;
}

export class ChannelResolver {
  constructor(
    private readonly ds: DataSource,
    private readonly enc: EncryptionService,
  ) {}

  /**
   * Resuelve el canal por phone_number_id. Devuelve null si no existe.
   * NO existe un tenant por defecto: enviar con credenciales ajenas es peor
   * que no enviar. El accessToken vuelve descifrado; quien lo reciba no debe
   * registrarlo jamás en logs.
   */
  async resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | null> {
    const [row] = await this.ds.query(
      `SELECT id, tenant_id, waba_id, phone_number_id, access_token_encrypted
         FROM whatsapp_channels
        WHERE phone_number_id = $1 AND status = 'active'`,
      [phoneNumberId],
    );
    if (!row) return null;

    return {
      tenantId: row.tenant_id,
      channelId: row.id,
      wabaId: row.waba_id,
      phoneNumberId: row.phone_number_id,
      accessToken: this.enc.decrypt(row.access_token_encrypted),
    };
  }
}
