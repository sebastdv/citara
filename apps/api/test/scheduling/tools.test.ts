import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { runInTenant } from '../../src/tenancy/tenant-context';
import type { ToolContext, ToolResult } from '../../src/scheduling/tools/registry';
import { resetDb, seedChannel, seedCatalog, seedHours, seedContact, adminQuery,
         closeHelpers, buildScheduling } from '../helpers';

let app: DataSource;
let s: ReturnType<typeof buildScheduling>;
let tenantId: string, contactId: string, conversationId: string, serviceId: string, resourceId: string;

const AHORA = new Date('2026-09-08T12:00:00Z');
const run = (name: string, args: unknown, who = contactId): Promise<ToolResult> =>
  runInTenant(app, tenantId, (m) =>
    s.tools.run(name, args, { m, tenantId, contactId: who, conversationId, now: AHORA } satisfies ToolContext));
const agendar = () => run('agendar_cita', {
  servicio_id: serviceId, recurso_id: resourceId, inicio: '2026-09-10T10:00:00-05:00', nombre: 'Ana' });

beforeAll(async () => { app = createDataSource(process.env.DATABASE_URL!); await app.initialize(); });
afterAll(async () => { await app.destroy(); await closeHelpers(); });
beforeEach(async () => {
  await resetDb();
  let channelId: string;
  ({ tenantId, channelId } = await seedChannel());
  ({ serviceId, resourceId } = await seedCatalog(tenantId));
  await seedHours(tenantId);
  contactId = await seedContact(tenantId);
  const [c] = await adminQuery(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, last_inbound_at)
     VALUES ($1, $2, $3, now()) RETURNING id`, [tenantId, contactId, channelId]);
  conversationId = c.id;
  s = buildScheduling();
});

describe('registro de herramientas', () => {
  it('marca como destructivas solo cancelar y reprogramar', () => {
    const destructivas = Object.values(s.tools.tools).filter((t) => t.destructive).map((t) => t.name);
    expect(destructivas.sort()).toEqual(['cancelar_cita', 'reprogramar_cita']);
  });

  it('ninguna herramienta acepta la identidad como argumento (R3)', () => {
    for (const tool of Object.values(s.tools.tools)) {
      const keys = Object.keys(tool.schema.shape);
      for (const k of ['tenant_id', 'contact_id', 'tenantId', 'contactId']) expect(keys).not.toContain(k);
    }
  });

  it('una herramienta desconocida o argumentos inválidos vuelven como error, sin lanzar', async () => {
    expect((await run('borrar_todo', {})).ok).toBe(false);
    expect((await run('consultar_disponibilidad', { servicio_id: 'no-es-uuid' })).ok).toBe(false);
  });
});

describe('consultas', () => {
  it('consultar_servicios lista los servicios activos', async () => {
    const res = await run('consultar_servicios', {});
    expect(res.data).toEqual([expect.objectContaining({ id: serviceId, nombre: 'Corte de cabello', duracion_min: 30 })]);
  });

  it('consultar_disponibilidad devuelve franjas con offset, recurso y etiqueta', async () => {
    const res = await run('consultar_disponibilidad', { servicio_id: serviceId, desde: '2026-09-10', hasta: '2026-09-10' });
    const [primera] = res.data as { inicio: string; recurso_id: string; etiqueta: string }[];
    expect(primera.inicio).toBe('2026-09-10T09:00:00-05:00');
    expect(primera.recurso_id).toBe(resourceId);
    expect(primera.etiqueta).toContain('09:00');
  });

  it('sin fechas mira desde hoy, y respeta el límite', async () => {
    const res = await run('consultar_disponibilidad', { servicio_id: serviceId, limite: '3' });
    const franjas = res.data as { inicio: string }[];
    expect(franjas).toHaveLength(3);
    expect(franjas[0].inicio).toBe('2026-09-08T09:00:00-05:00'); // martes 07:00 local + 60 min de anticipación
  });

  it('rechaza un rango invertido con un error legible', async () => {
    const res = await run('consultar_disponibilidad', { servicio_id: serviceId, desde: '2026-09-11', hasta: '2026-09-10' });
    expect(res.error).toMatch(/rango/i);
  });
});

describe('agendar_cita', () => {
  it('agenda y devuelve la cita', async () => {
    const res = await agendar();
    expect(res.data).toMatchObject({ estado: 'confirmed', inicio: '2026-09-10T10:00:00-05:00' });
  });

  it('si la franja está ocupada, responde con un mensaje útil', async () => {
    await agendar();
    const res = await agendar();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ocupada/i);
  });

  it('rechaza una fecha sin offset: nunca adivina la zona (R2)', async () => {
    const res = await run('agendar_cita', { servicio_id: serviceId, recurso_id: resourceId,
                                            inicio: '2026-09-10T10:00:00', nombre: 'Ana' });
    expect(res.error).toMatch(/offset/i);
  });

  it('rechaza una fecha en el pasado', async () => {
    const res = await run('agendar_cita', { servicio_id: serviceId, recurso_id: resourceId,
                                            inicio: '2020-01-01T10:00:00-05:00', nombre: 'Ana' });
    expect(res.ok).toBe(false);
  });
});

describe('confirmación en dos tiempos (R4)', () => {
  it('la primera llamada a cancelar NO cancela: devuelve detalles y un token', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const primera = await run('cancelar_cita', { cita_id: id });
    expect(primera.confirmationToken).toBeTruthy();
    expect(primera.data).toMatchObject({ requiere_confirmacion: true });
    expect(((await run('consultar_mis_citas', {})).data as unknown[])).toHaveLength(1);
  });

  it('la segunda llamada con el token sí cancela', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const { confirmationToken } = await run('cancelar_cita', { cita_id: id });
    expect((await run('cancelar_cita', { cita_id: id, confirmation_token: confirmationToken })).ok).toBe(true);
    expect(((await run('consultar_mis_citas', {})).data as unknown[])).toHaveLength(0);
  });

  it('rechaza un token inventado', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    expect((await run('cancelar_cita', { cita_id: id, confirmation_token: 'inventado' })).ok).toBe(false);
  });

  it('el token de cancelar no sirve para reprogramar', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const { confirmationToken } = await run('cancelar_cita', { cita_id: id });
    const res = await run('reprogramar_cita', { cita_id: id, nuevo_inicio: '2026-09-10T11:00:00-05:00',
                                                confirmation_token: confirmationToken });
    expect(res.ok).toBe(false);
  });

  it('no cancela la cita de otro contacto ni con un token válido', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const { confirmationToken } = await run('cancelar_cita', { cita_id: id });
    const intruso = await seedContact(tenantId, '573009990000');
    expect((await run('cancelar_cita', { cita_id: id, confirmation_token: confirmationToken }, intruso)).ok).toBe(false);
  });

  it('reprogramar avisa antes de pedir confirmación si el horario nuevo no sirve', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const res = await run('reprogramar_cita', { cita_id: id, nuevo_inicio: '2026-09-13T10:00:00-05:00' }); // domingo
    expect(res.ok).toBe(false);
    expect(res.confirmationToken).toBeUndefined();
  });

  it('reprogramar acepta un horario que se solapa con la propia cita', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const res = await run('reprogramar_cita', { cita_id: id, nuevo_inicio: '2026-09-10T10:15:00-05:00' });
    expect(res.confirmationToken).toBeTruthy();
  });

  it('reprogramar con el token mueve la cita', async () => {
    const id = ((await agendar()).data as { id: string }).id;
    const args = { cita_id: id, nuevo_inicio: '2026-09-10T11:00:00-05:00' };
    const { confirmationToken } = await run('reprogramar_cita', args);
    const res = await run('reprogramar_cita', { ...args, confirmation_token: confirmationToken });
    expect(res.data).toMatchObject({ inicio: '2026-09-10T11:00:00-05:00' });
  });
});
