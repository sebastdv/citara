import type { DataSource } from 'typeorm';
import { DateTime } from 'luxon';
import type { InboundMessage } from '@citara/shared';
import type { EncryptionService } from '../../crypto/encryption.service';
import type { LlmProvider } from '../llm';
import { AgentService } from '../agent.service';
import { InterpreterService } from '../interpreter.service';
import { AiGate } from '../ai-gate';
import { AgentProcessor } from '../agent.processor';
import type { AgentYaml } from '../agent-config';
import { applyTenantConfig } from '../../cli/tenant-config';
import { FlowRunner } from '../../flow-engine/flow-runner.service';
import { InboundProcessor } from '../../queues/inbound.processor';
import type { AgentJob } from '../../queues/agent.queue';
import { AvailabilityService } from '../../scheduling/availability.service';
import { BookingService } from '../../scheduling/booking.service';
import { RemindersService } from '../../scheduling/reminders.service';
import { ToolRegistry } from '../../scheduling/tools/registry';
import { BENCH_CUSTOMER, BENCH_NOW, BENCH_OTHER, BENCH_SCRIPTS, BENCH_TENANT, type BenchScript } from './scripts';

export interface BenchResult { name: string; passed: boolean; reason: string | null; usd: number; replies: string[] }

const TZ = 'America/Bogota';
const TABLES = `google_accounts, agent_runs, agent_configs, onboarding_links, reminders, webhook_events, audit_log,
  messages, conversation_sessions, conversations, flows, appointments, business_hours, time_off,
  resource_services, resources, services, contacts, whatsapp_channels, tenants`;
const local = (iso: string) => DateTime.fromFormat(iso, 'yyyy-MM-dd HH:mm', { zone: TZ }).toJSDate();
const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(TZ).toFormat('yyyy-MM-dd HH:mm');

/**
 * Cada guion corre aislado: base vacía, el negocio del banco con la
 * configuración del agente a probar, y el pipeline real en proceso (FlowRunner
 * y AgentProcessor, sin Redis: los jobs del agente se atienden en el acto).
 */
export async function runBench(o: { admin: DataSource; app: DataSource; llm: LlmProvider; agent: AgentYaml;
                                    enc: EncryptionService; scripts?: BenchScript[] }): Promise<BenchResult[]> {
  const out: BenchResult[] = [];
  for (const script of o.scripts ?? BENCH_SCRIPTS) out.push(await runOne(o, script));
  return out;
}

/**
 * El banco vacía todas las tablas en cada guion: solo corre sobre una base de
 * banco o de pruebas. Apuntarlo por error a la base real borraría a los clientes.
 */
export function assertBenchDatabase(name: string): void {
  if (!/bench|test/i.test(name)) {
    throw new Error(`El banco vacía la base en cada guion y '${name}' no es una base de banco ` +
                    `(usa citara_bench o una base de pruebas).`);
  }
}

async function runOne(o: Parameters<typeof runBench>[0], script: BenchScript): Promise<BenchResult> {
  const { admin, app } = o;
  const [{ db }] = await admin.query(`SELECT current_database() AS db`);
  assertBenchDatabase(db);
  await admin.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
  const [t] = await admin.query(`INSERT INTO tenants (slug, name, timezone) VALUES ('banco', 'Salón Banco', $1) RETURNING id`, [TZ]);
  const [ch] = await admin.query(
    `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, access_token_encrypted)
     VALUES ($1, '999', '999000', $2) RETURNING id`, [t.id, o.enc.encrypt('token-del-banco')]);
  await applyTenantConfig(admin, { ...BENCH_TENANT, agent: o.agent }, { skipBench: true });
  await setup(admin, t.id, script.setup);

  const clock = { now: () => BENCH_NOW };
  const availability = new AvailabilityService();
  const tools = new ToolRegistry(availability, new BookingService(availability, new RemindersService(app)));
  const jobs: AgentJob[] = [];
  const agents = { add: (j: AgentJob) => { jobs.push(j); } };
  const noop = { add: () => undefined };
  const flows = new FlowRunner(app, new InboundProcessor(app), noop, tools, clock, agents, new AiGate());
  const processor = new AgentProcessor(app, new AgentService(app, o.llm, tools), new InterpreterService(app, o.llm),
    new AiGate(), flows, noop, agents, { resolveById: async () => null } as never, {} as never, clock);

  for (const [i, text] of script.turns.entries()) {
    await flows.handle({ tenantId: t.id, channelId: ch.id, message: {
      wamid: `banco.${script.name}.${i}`, phoneNumberId: '999000', wabaId: '999', from: BENCH_CUSTOMER,
      profileName: 'Cliente', type: 'text', text, mediaId: null, timestamp: BENCH_NOW, raw: {} } as InboundMessage });
    while (jobs.length) {
      const job = jobs.shift()!;
      while ((await processor.process(job)) === 'busy') await new Promise((r) => setTimeout(r, 200));
    }
  }

  const replies = (await admin.query(
    `SELECT body FROM messages WHERE direction = 'out' AND body IS NOT NULL ORDER BY created_at`))
    .map((r: { body: string }) => r.body);
  const [{ usd }] = await admin.query(`SELECT COALESCE(sum(usd), 0) AS usd FROM agent_runs`);
  const reason = await check(admin, script, replies);
  return { name: script.name, passed: reason === null, reason, usd: Number(usd), replies };
}

async function setup(admin: DataSource, tenantId: string, kind: BenchScript['setup']) {
  if (!kind) return;
  const contact = async (waId: string) => (await admin.query(
    `INSERT INTO contacts (tenant_id, wa_id, name) VALUES ($1, $2, 'Ana') RETURNING id`, [tenantId, waId]))[0].id;
  const book = async (contactId: string, resourceKey: string) => admin.query(
    `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, customer_name)
     SELECT $1, r.id, s.id, $2, $3, $3::timestamptz + interval '30 minutes', 'Ana'
       FROM resources r, services s WHERE r.key = $4 AND s.key = 'corte'`,
    [tenantId, contactId, local('2026-09-08 10:00'), resourceKey]);
  if (kind === 'cita_manana_10') await book(await contact(BENCH_CUSTOMER), 'maria');
  if (kind === 'ocupado_manana_10') {
    const otro = await contact(BENCH_OTHER);
    await book(otro, 'maria');
    await book(otro, 'pedro');
  }
}

/** null si el guion se cumplió; si no, por qué. Se afirma sobre la base, no sobre el texto. */
async function check(admin: DataSource, script: BenchScript, replies: string[]): Promise<string | null> {
  const e = script.expect;
  const citas: { service: string; starts_at: Date; status: string; customer_name: string }[] = await admin.query(
    `SELECT s.key AS service, a.starts_at, a.status, a.customer_name
       FROM appointments a JOIN services s ON s.id = a.service_id JOIN contacts c ON c.id = a.contact_id
      WHERE c.wa_id = $1 ORDER BY a.created_at`, [BENCH_CUSTOMER]);
  const confirmed = citas.filter((c) => c.status === 'confirmed');
  if (e.booked) {
    const ok = confirmed.some((c) => c.service === e.booked!.service && fmt(c.starts_at) === e.booked!.at
      && (!e.booked!.name || c.customer_name.toLowerCase().includes(e.booked!.name.toLowerCase())));
    if (!ok) return `se esperaba una cita de ${e.booked.service} el ${e.booked.at}; hay: ${describe(confirmed)}`;
  }
  if (e.bookedOn && !confirmed.some((c) => c.service === e.bookedOn!.service && fmt(c.starts_at).startsWith(e.bookedOn!.date))) {
    return `se esperaba una cita de ${e.bookedOn.service} el ${e.bookedOn.date}; hay: ${describe(confirmed)}`;
  }
  if (e.noBooking && confirmed.length) return `no debía agendar y hay: ${describe(confirmed)}`;
  if (e.cancelled && citas[0]?.status !== 'cancelled') return 'la cita debía quedar cancelada';
  if (e.kept && (citas[0]?.status !== 'confirmed' || fmt(citas[0].starts_at) !== '2026-09-08 10:00')) {
    return 'la cita debía seguir igual';
  }
  if (e.movedTo && (citas[0]?.status !== 'confirmed' || fmt(citas[0].starts_at) !== e.movedTo)) {
    return `la cita debía quedar el ${e.movedTo}; hay: ${describe(citas)}`;
  }
  if (e.handoff) {
    const [c] = await admin.query(`SELECT control FROM conversations`);
    if (c?.control !== 'human') return 'debía pasar la conversación a un humano';
  }
  if (e.replyMatches && !replies.some((r) => new RegExp(e.replyMatches!, 'i').test(r))) {
    return `ninguna respuesta coincide con /${e.replyMatches}/`;
  }
  return null;
}

const describe = (citas: { service: string; starts_at: Date; status: string }[]) =>
  citas.length ? citas.map((c) => `${c.service} ${fmt(c.starts_at)} (${c.status})`).join(', ') : 'ninguna';

// La compuerta vive aparte: tenant-config la usa y este archivo usa tenant-config.
export { assertBenchPassed, writeBenchResult } from './results';
