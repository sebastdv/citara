import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  /** id de mensaje de WhatsApp; null para mensajes que aún no confirma Meta. */
  @Column({ type: 'varchar', nullable: true })
  wamid!: string | null;

  @Column({ type: 'varchar' })
  direction!: 'in' | 'out';

  @Column({ type: 'varchar' })
  origin!: 'customer' | 'bot' | 'phone' | 'operator' | 'history' | 'reminder';

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column()
  type!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: unknown | null;

  @Column({ type: 'varchar', nullable: true })
  status!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
