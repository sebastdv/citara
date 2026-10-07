import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FlowDefinition } from '@citara/shared';
import { ConversationHarness } from './conversation-harness';
import { AGENDA_FLOW } from '../../src/flow-engine/flows/agenda';
import { resetDb, seedChannel, seedCatalog, seedHours, seedFlow, seedContact, adminQuery, closeHelpers } from '../helpers';

// Lunes 7 de septiembre, 22:00 en Bogotá: la primera franja es el martes 09:00 (14:00Z).
const AHORA = new Date('2026-09-08T03:00:00Z');
let h: ConversationHarness, tenantId: string, channelId: string, serviceId: string, resourceId: string;

async function start(flow: FlowDefinition = AGENDA_FLOW) {
  await seedFlow(tenantId, flow);
  h = await ConversationHarness.create({ tenantId, channelId, from: '573001112233', now: AHORA });
}
const hastaElNombre = async () => {
  await h.say('Hola');
  await h.tap('agendar');
  await h.say('1');            // servicio
  await h.say('1');            // primer día
  await h.say('1');            // primera hora
};

beforeEach(async () => {
  await resetDb();
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
});
afterAll(async () => { await ConversationHarness.teardown(); await closeHelpers(); });

describe('agendar una cita solo con menús', () => {
  it('recorre menú → servicio → día → hora → nombre → cita creada', async () => {
    await start();
    await h.say('Hola');
    const servicios = await h.tap('agendar');
    expect(servicios.at(-1)).toMatchObject({ body: expect.stringContaining('1. Corte de cabello (30 min)') });

    const dias = await h.say('1');
    expect(dias[0]).toMatchObject({ body: expect.stringContaining('1. martes 8 de septiembre') });

    const horas = await h.say('1');
    expect(horas[0]).toMatchObject({ body: expect.stringContaining('1. 09:00 con María') });
    expect(horas[0]).toMatchObject({ body: expect.stringContaining('17:00 con María') }); // todo el día

    await h.say('1');
    const fin = await h.say('Ana');
    expect(fin[0]).toMatchObject({ body: expect.stringMatching(/^¡Listo, Ana! Tu cita quedó para el martes .* con María\.$/) });

    const citas = await adminQuery(`SELECT starts_at, customer_name, status, conversation_id FROM appointments`);
    expect(citas).toHaveLength(1);
    expect(new Date(citas[0].starts_at).toISOString()).toBe('2026-09-08T14:00:00.000Z');
    expect([citas[0].customer_name, citas[0].status]).toEqual(['Ana', 'confirmed']);
    expect(citas[0].conversation_id).toBeTruthy();
  });

  it('si la hora se ocupa antes de reservar, explica el motivo y vuelve a mostrar las horas', async () => {
    await start();
    await hastaElNombre();
    const otro = await seedContact(tenantId, '573000000000');
    await adminQuery(
      `INSERT INTO appointments (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, '2026-09-08T14:00:00Z', '2026-09-08T14:30:00Z')`,
      [tenantId, resourceId, serviceId, otro]);

    const fin = await h.say('Ana');
    expect(fin[0]).toMatchObject({ body: expect.stringContaining('No pude agendar ese horario: Esa franja ya está ocupada') });
    expect(fin[1]).toMatchObject({ body: expect.stringContaining('Responde con el número') });
    expect(fin[1]).not.toMatchObject({ body: expect.stringContaining('1. 09:00 con María') });
  });

  it('si el turno falla después de agendar, la cita no queda creada', async () => {
    await start({ ...AGENDA_FLOW, steps: { ...AGENDA_FLOW.steps,
      reservar: { ...(AGENDA_FLOW.steps.reservar as any), on_success: 'paso_que_no_existe' } } });
    await hastaElNombre();

    await expect(h.say('Ana')).rejects.toThrow(/Paso inexistente/);
    const [{ n }] = await adminQuery(`SELECT count(*)::int AS n FROM appointments`);
    expect(n).toBe(0);
  });

  it('elegir un número fuera de la lista repite la pregunta', async () => {
    await start();
    await h.say('Hola'); await h.tap('agendar');
    const res = await h.say('99');
    expect(res[0]).toMatchObject({ body: expect.stringContaining('¿Qué servicio necesitas?') });
  });

  it('sin horarios libres lo dice en vez de mostrar una lista vacía', async () => {
    await adminQuery(`DELETE FROM business_hours`);
    await start();
    await h.say('Hola'); await h.tap('agendar');
    const res = await h.say('1');            // servicio → no hay días con cupo
    expect(res[0]).toMatchObject({ body: expect.stringContaining('No encontré horarios libres') });
  });

  it('mis citas lista las próximas', async () => {
    await start();
    await hastaElNombre();
    await h.say('Ana');
    await h.say('Hola');
    const res = await h.tap('mis_citas');
    expect(res[0]).toMatchObject({ body: expect.stringContaining('Corte de cabello') });
  });
});
