import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DataSource, type EntityManager } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import { RemindersService } from '../../src/scheduling/reminders.service';
import { OutboundProcessor } from '../../src/queues/outbound.processor';
import { ChannelResolver } from '../../src/tenancy/channel-resolver.service';
import { EncryptionService } from '../../src/crypto/encryption.service';
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

  it('reprogramar reemplaza los recordatorios por los de la hora nueva', async () => {
    const cita = await agendar();
    await inTenant((m) => s.booking.reschedule(m, tenantId, cita.id, contactId, new Date('2026-09-11T15:00:00Z'), AHORA));
    const rows = await reminders(cita.id);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['pending', 'pending']);
    expect(rows.map((r: { send_at: Date }) => new Date(r.send_at).toISOString()))
      .toEqual(['2026-09-10T15:00:00.000Z', '2026-09-11T13:00:00.000Z']);
  });

  it('mover la cita después del barrido retira el recordatorio ya encolado con la hora vieja', async () => {
    const cita = await agendar();
    await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    await inTenant((m) => s.booking.reschedule(m, tenantId, cita.id, contactId, new Date('2026-09-11T15:00:00Z'), AHORA));
    const [msg] = await adminQuery(`SELECT status FROM messages WHERE origin = 'reminder'`);
    expect(msg.status).toBe('superseded');
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
    // 25 citas FUTURAS (jueves 10, viernes 11, lunes 14) cuyo recordatorio de
    // 24 h ya venció. El de 2 h se quita para contar uno por cita.
    for (let i = 0; i < 25; i++) {
      const otro = await seedContact(tenantId, `5730000000${String(i).padStart(2, '0')}`);
      const day = [10, 11, 14][Math.floor(i / 9)], slot = i % 9;
      await inTenant((m) => s.booking.book(m, tenantId, { serviceId, resourceId, contactId: otro,
        startsAt: new Date(Date.UTC(2026, 8, day, 14 + slot)), customerName: `C${i}`, now: AHORA }));
    }
    await adminQuery(`DELETE FROM reminders WHERE kind = '2h'`);
    await adminQuery(`UPDATE reminders SET send_at = '2026-09-09T11:00:00Z'`);
    const jobs = await s.reminders.sweep(new Date('2026-09-09T12:00:00Z'));
    const delays = jobs.map((j) => j.delay).sort((a, b) => a - b);
    expect(delays).toEqual([...Array(10).fill(0), ...Array(10).fill(1000), ...Array(5).fill(2000)]);
  });

  it('no envía recordatorios de una cita que ya pasó', async () => {
    // Canal caído, negocio suspendido o worker detenido: al volver, lo vencido
    // de citas ya pasadas no debe salir.
    const cita = await agendar();
    expect(await s.reminders.sweep(new Date('2026-09-10T16:00:00Z'))).toEqual([]);
    expect((await reminders(cita.id)).map((r: { status: string }) => r.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('a menos de 2 h de la cita sale solo el de 2 h, no también el de 24 h atrasado', async () => {
    const cita = await agendar();
    const jobs = await s.reminders.sweep(new Date('2026-09-10T13:30:00Z'));
    expect(jobs).toHaveLength(1);
    const [msg] = await adminQuery(`SELECT payload FROM messages WHERE origin = 'reminder'`);
    expect(msg.payload.name).toBe('recordatorio_cita_2h');
    expect((await reminders(cita.id)).map((r: { status: string }) => r.status)).toEqual(['cancelled', 'queued']);
  });

  it('cancelar después del barrido retira también el recordatorio ya encolado', async () => {
    const cita = await agendar();
    await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    await inTenant((m) => s.booking.cancel(m, cita.id, contactId));
    const [msg] = await adminQuery(`SELECT status FROM messages WHERE origin = 'reminder'`);
    expect(msg.status).toBe('superseded');
  });

  it('el envío no saca un recordatorio cuya cita ya no está confirmada', async () => {
    // Aunque algo cambie la cita sin pasar por cancelFor, el reclamo lo frena.
    const cita = await agendar();
    const [{ job }] = await s.reminders.sweep(new Date('2026-09-09T15:01:00Z'));
    await adminQuery(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [cita.id]);
    const enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!);
    await enc.ready();
    const send = vi.fn();
    await new OutboundProcessor(app, new ChannelResolver(app, enc), { send } as never).process(job);
    expect(send).not.toHaveBeenCalled();
    const [msg] = await adminQuery(`SELECT status FROM messages WHERE origin = 'reminder'`);
    expect(msg.status).toBe('superseded');
  });
});
