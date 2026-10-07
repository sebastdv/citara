import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'contact_id', type: 'uuid' })
  contactId!: string;

  @Column({ name: 'channel_id', type: 'uuid' })
  channelId!: string;

  @Column({ default: 'open' })
  status!: 'open' | 'closed';

  @Column({ type: 'varchar', default: 'bot' })
  control!: 'bot' | 'human';

  @Column({ name: 'human_until', type: 'timestamptz', nullable: true })
  humanUntil!: Date | null;

  @Column({ name: 'control_reason', type: 'varchar', nullable: true })
  controlReason!: 'phone' | 'flow_handoff' | 'operator' | 'history' | null;

  @Column({ name: 'last_inbound_at', type: 'timestamptz', nullable: true })
  lastInboundAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
