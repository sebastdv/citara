import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Tenant } from './entities/tenant.entity';
import { Contact } from './entities/contact.entity';
import { WhatsappChannel } from './entities/whatsapp-channel.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { WebhookEvent } from './entities/webhook-event.entity';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: [Tenant, Contact, WhatsappChannel, Conversation, Message, WebhookEvent],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
    logging: false,
  });
}
