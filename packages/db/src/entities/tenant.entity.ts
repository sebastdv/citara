import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  slug!: string;

  @Column()
  name!: string;

  /** IANA, p.ej. America/Bogota. Fuente de verdad para presentar horarios. */
  @Column({ default: 'America/Bogota' })
  timezone!: string;

  @Column({ default: 'active' })
  status!: 'active' | 'suspended';

  @Column({ name: 'human_takeover_hours', type: 'smallint', default: 12 })
  humanTakeoverHours!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
