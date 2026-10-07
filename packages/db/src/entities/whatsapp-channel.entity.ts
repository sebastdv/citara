import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sin RLS a propósito: se resuelve por `phoneNumberId` ANTES de conocer el
 * tenant (ver `packages/db/test/rls-inventory.test.ts` y `ChannelResolver`).
 * El `accessTokenEncrypted` viaja siempre cifrado; descifrarlo es trabajo de
 * `ChannelResolver`, no de esta entidad.
 */
@Entity('whatsapp_channels')
export class WhatsappChannel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'waba_id' })
  wabaId!: string;

  @Column({ name: 'phone_number_id', unique: true })
  phoneNumberId!: string;

  @Column({ name: 'display_phone_number', type: 'varchar', nullable: true })
  displayPhoneNumber!: string | null;

  @Column({ name: 'access_token_encrypted', type: 'bytea' })
  accessTokenEncrypted!: Buffer;

  @Column({ default: 'active' })
  status!: string;

  @Column({ type: 'varchar', default: 'cloud_api' })
  mode!: 'cloud_api' | 'coexistence';

  @Column({ name: 'history_sync', type: 'varchar', default: 'not_applicable' })
  historySync!: 'not_applicable' | 'pending' | 'done' | 'declined';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
