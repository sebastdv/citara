import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { RemindersService } from '../../src/scheduling/reminders.service';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let s: ReturnType<typeof buildScheduling>;
let tenantId: string, channelId: string, serviceId: string, resourceId: string, contactId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const CITA = new Date('2026-09-10T15:00:00Z');
const inTenant = <T>(fn: (m: EntityManager) => Promise<T>) => runInTenant(app, tenantId, fn);
const agendar = (startsAt = CITA) => inTenant((m) => s.booking.book(m, tenantId,
  { serviceId, resourceId, contactId, startsAt, customerName: 'Ana', now: AHORA }));
const reminders = (appointmentId?: string) => adminQuery(
  `SELECT kind, send_at, status, message_id FROM reminders
    ${appointmentId ? 'WHERE appointment_id = $1' : ''} ORDER BY send_at`, appointmentId ? [appointmentId] : []);

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  s = buildScheduling(app);
});

describe('programación', () => {
  it('agendar programa los recordatorios de 24 h y 2 h', async () => {
    const cita = await agendar();
    const rows = await reminders(cita.id);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['24h', '2h']);
    expect(new Date(rows[0].send_at).toISOString()).toBe('2026-09-09T15:00:00.000Z');
    expect(new Date(rows[1].send_at).toISOString()).toBe('2026-09-10T13:00:00.000Z');
  });

  it('no programa un recordatorio cuyo momento ya pasó', async () => {
    const cita = await agendar(new Date('2026-09-08T15:00:00Z')); // en 3 horas
    expect((await reminders(cita.id)).map((r: { kind: string }) => r.kind)).toEqual(['2h']);
  });

  it('cancelar la cita cancela sus recordatorios', async () => {
    const cita = await agendar();
    await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    expect((await reminders(cita.id)).every((r: { status: string }) => r.status === 'cancelled')).toBe(true);
  });

  it('reprogramar cancela los de la hora vieja y programa los de la nueva', async () => {
    const cita = await agendar();
    const nueva = await inTenant((m) => s.booking.reschedule(
      m, tenantId, cita.id, contactId, new Date('2026-09-11T15:00:00Z'), AHORA));
    expect((await reminders(cita.id)).map((r: { status: string }) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect((await reminders(nueva.id)).map((r: { status: string }) => r.status)).toEqual(['pending', 'pending']);
  });
});

describe('barrido', () => {
  it('deja un mensaje plantilla pendiente en la conversación y marca el recordatorio', async () => {
    const cita = await agendar();
    const jobs = await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));

    expect(jobs).toHaveLength(1);
    const [msg] = await adminQuery(`SELECT origin, type, status, payload, conversation_id FROM messages`);
    expect(msg).toMatchObject({ origin: 'reminder', type: 'template', status: 'pending' });
    expect(msg.payload).toMatchObject({ kind: 'template', name: 'recordatorio_cita_24h', language: 'es' });
    expect(msg.payload.params[0]).toBe('Ana');
    expect(jobs[0].job).toMatchObject({ tenantId, channelId, conversationId: msg.conversation_id, to: '573001112233' });
    const [r] = await reminders(cita.id);
    expect(r.status).toBe('queued');
  });

  it('un segundo barrido no duplica', async () => {
    await agendar();
    await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    expect(await s.reminders.sweep(new Date('2026-09-09T15:02:00Z'))).toEqual([]);
  });

  it('vuelve a encolar un recordatorio que quedó sin enviar', async () => {
    // El barrido guardó el mensaje pero el encolado posterior falló.
    await agendar();
    await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    await adminQuery(`UPDATE messages SET created_at = now() - interval '10 minutes'`);
    const again = await s.reminders.sweep(new Date('2026-09-09T15:02:00Z'));
    expect(again).toHaveLength(1);
  });

  it('reparte los envíos de un canal a no más de 10 por segundo', async () => {
    // 25 citas de 30 min: jueves 10, viernes 11 y lunes 14 (el 12 es sábado, sin horario).
    for (let i = 0; i < 25; i++) {
      const otro = await seedContact(tenantId, `5730000000${String(i).padStart(2, '0')}`);
      const day = [10, 11, 14][Math.floor(i / 9)], slot = i % 9;
      await inTenant((m) => s.booking.book(m, tenantId, { serviceId, resourceId, contactId: otro,
        startsAt: new Date(Date.UTC(2026, 8, day, 14 + slot)), customerName: `C${i}`, now: AHORA }));
    }
    const jobs = await s.reminders.sweep(new Date('2026-09-15T00:00:00Z')); // todo vencido
    const delays = jobs.map((j) => j.delay);
    expect(delays.filter((d) => d === 0)).toHaveLength(10);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(4000); // 50 recordatorios → 5 segundos
  });
});
