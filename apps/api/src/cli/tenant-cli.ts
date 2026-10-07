// La CLI del operador: pnpm tenant <create|link|suspend|resume|list|sync> ...
import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { createDataSource } from '@citara/db';
import { EncryptionService } from '../crypto/encryption.service';
import { MetaOnboardingClient } from '../onboarding/meta-onboarding.client';
import { connectUrl, createTenant, listTenants, newLink, setSuspended, syncTenant, type TenantSummary } from './tenants';

const USAGE = `Uso:
  pnpm tenant create <slug> "<nombre>" [zona]   crea el negocio en alta e imprime el enlace de conexión
  pnpm tenant link <slug>                         imprime un enlace de conexión nuevo
  pnpm tenant suspend <slug> | resume <slug>      saca o devuelve el negocio a operación
  pnpm tenant list                                estado de los negocios y sus canales
  pnpm tenant sync <slug>                         reintenta la sincronización de historial y contactos`;

const fmt = (d: Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');
const SYNC_NAMES = { smb_app_state_sync: 'contactos', history: 'historial' } as const;
/** "sync contactos ok, historial FALLÓ": una falla se reintenta con `pnpm tenant sync` dentro de 24 h. */
const fmtSyncs = (syncs: TenantSummary['syncs']) => {
  const parts = (Object.keys(SYNC_NAMES) as (keyof typeof SYNC_NAMES)[])
    .filter((k) => syncs[k])
    .map((k) => `${SYNC_NAMES[k]} ${syncs[k] === 'failed' ? 'FALLÓ' : 'ok'}`);
  return `sync ${parts.length ? parts.join(', ') : '—'}`;
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL no está definida');
  const admin = createDataSource(url);
  await admin.initialize();
  try {
    switch (cmd) {
      case 'create': {
        const [slug, name, timezone] = args;
        if (!slug || !name) throw new Error(USAGE);
        const { token } = await createTenant(admin, { slug, name, timezone });
        console.log(`Negocio '${slug}' creado en alta. Envíale este enlace (vence en 72 h, un solo uso):\n${connectUrl(token)}`);
        break;
      }
      case 'link':
        if (!args[0]) throw new Error(USAGE);
        console.log(connectUrl(await newLink(admin, args[0])));
        break;
      case 'suspend':
      case 'resume':
        if (!args[0]) throw new Error(USAGE);
        console.log(`'${args[0]}' quedó ${await setSuspended(admin, args[0], cmd === 'suspend')}`);
        break;
      case 'list':
        for (const t of await listTenants(admin)) {
          console.log([t.slug, t.status, t.phone ?? 'sin número', t.mode ?? '—', t.channelStatus ?? '—',
                       `historial ${t.historySync ?? '—'}`, fmtSyncs(t.syncs), `último eco ${fmt(t.lastPhoneEcho)}`,
                       `último cliente ${fmt(t.lastCustomer)}`].join(' | '));
        }
        break;
      case 'sync': {
        if (!args[0]) throw new Error(USAGE);
        const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
        await enc.ready();
        const meta = new MetaOnboardingClient(process.env.META_GRAPH_VERSION ?? 'v25.0',
          process.env.META_APP_ID ?? '', process.env.META_APP_SECRET ?? '');
        console.log(await syncTenant(admin, enc, meta, args[0]));
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    await admin.destroy();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
