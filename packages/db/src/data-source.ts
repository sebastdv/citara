import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Tenant } from './entities/tenant.entity';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: [Tenant],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
    logging: false,
  });
}
