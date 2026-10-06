import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
// Imports de VALOR: ToolRegistry es @Injectable() y Nest los resuelve por tipo.
import { AvailabilityService } from '../availability.service';
import { BookingService } from '../booking.service';
import { SchedulingError, SlotTakenError } from '../scheduling.errors';
import { isoIn, labelFor } from '../format';

export interface ToolContext {
  /** La transacción del turno: RLS fijado y la conversación bloqueada. */
  m: EntityManager;
  tenantId: string;
  contactId: string;
  conversationId: string;
  now: Date;
}

export interface ToolResult { ok: boolean; data?: unknown; error?: string; confirmationToken?: string }

export interface ToolDefinition {
  name: string;
  /** Se le entrega al modelo en la fase del agente. */
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  destructive: boolean;
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

/** ISO-8601 que EXIGE offset (R2): nunca se adivina la zona de una fecha suelta. */
const isoWithOffset = z.string().refine(
  (v) => /([+-]\d{2}:\d{2}|Z)$/.test(v) && DateTime.fromISO(v, { setZone: true }).isValid,
  'La fecha debe incluir offset de zona, p. ej. 2026-09-10T10:00:00-05:00');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

/**
 * Token de confirmación (R4) ligado a la herramienta, la cita, quien pregunta
 * y lo que se va a aplicar: el de cancelar no sirve para reprogramar, ni el de
 * un horario para otro. Llave derivada (no la de cifrado tal cual) y sin estado
 * que guardar.
 */
function tokenFor(parts: string[]): string {
  const key = createHmac('sha256', process.env.DB_ENCRYPTION_KEY!).update('citara/tool-confirmation').digest();
  return createHmac('sha256', key).update(parts.join('|')).digest('hex').slice(0, 32);
}
function sameToken(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

@Injectable()
export class ToolRegistry {
  readonly tools: Record<string, ToolDefinition>;

  constructor(
    private readonly availability: AvailabilityService,
    private readonly booking: BookingService,
  ) {
    this.tools = Object.fromEntries(this.definitions().map((t) => [t.name, t]));
  }

  /**
   * Valida, ejecuta y normaliza. Un error de dominio vuelve como
   * `{ ok: false, error }` para que el menú (o el modelo) lo explique; cualquier
   * otro error es un fallo del sistema y se propaga: el turno se revierte y se
   * reintenta.
   */
  async run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools[name];
    if (!tool) return { ok: false, error: `Herramienta desconocida: ${name}` };
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
    try {
      return await tool.run(parsed.data, ctx);
    } catch (err) {
      if (err instanceof SlotTakenError) return { ok: false, error: 'Esa franja ya está ocupada. Ofrece otro horario.' };
      if (err instanceof SchedulingError) return { ok: false, error: err.message };
      throw err;
    }
  }

  private definitions(): ToolDefinition[] {
    const { availability, booking } = this;
    return [
      {
        name: 'consultar_servicios',
        description: 'Lista los servicios que ofrece el negocio, con duración y precio.',
        schema: z.object({}),
        destructive: false,
        async run(_args, ctx) {
          return { ok: true, data: await availability.listServices(ctx.m) };
        },
      },
      {
        name: 'consultar_disponibilidad',
        description: 'Franjas libres para un servicio. Sin fechas, los próximos 7 días.',
        schema: z.object({
          servicio_id: z.string().uuid(),
          recurso_id: z.string().uuid().optional(),
          desde: day.optional(),
          hasta: day.optional(),
          limite: z.coerce.number().int().min(1).max(50).default(20),
        }),
        destructive: false,
        async run(a, ctx) {
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const desde = a.desde ? DateTime.fromISO(a.desde, { zone: timezone })
                                : DateTime.fromJSDate(ctx.now).setZone(timezone);
          const hasta = a.hasta ? DateTime.fromISO(a.hasta, { zone: timezone }) : desde.plus({ days: 6 });
          if (hasta < desde.startOf('day')) return { ok: false, error: 'El rango de fechas está invertido' };

          const slots = await availability.slotsFor(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id ?? null,
            from: desde.startOf('day').toJSDate(), to: hasta.endOf('day').toJSDate(), now: ctx.now });
          return {
            ok: true,
            data: slots.slice(0, a.limite).map((x) => ({
              inicio: isoIn(x.start, timezone), fin: isoIn(x.end, timezone),
              recurso_id: x.resourceId, recurso: x.resourceName, etiqueta: labelFor(x.start, timezone),
            })),
          };
        },
      },
      {
        name: 'consultar_mis_citas',
        description: 'Lista las próximas citas confirmadas de quien escribe.',
        schema: z.object({}),
        destructive: false,
        async run(_args, ctx) {
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const citas = await booking.listForContact(ctx.m, ctx.contactId, ctx.now);
          return {
            ok: true,
            data: citas.map((c) => ({ id: c.id, inicio: isoIn(c.startsAt, timezone), servicio: c.serviceName,
                                      recurso: c.resourceName, etiqueta: labelFor(c.startsAt, timezone) })),
          };
        },
      },
      {
        name: 'agendar_cita',
        description: 'Reserva una cita en una franja disponible.',
        schema: z.object({
          servicio_id: z.string().uuid(),
          recurso_id: z.string().uuid(),
          inicio: isoWithOffset,
          nombre: z.string().trim().min(1).max(255),
          notas: z.string().max(1000).optional(),
        }),
        destructive: false,
        async run(a, ctx) {
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const cita = await booking.book(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id, contactId: ctx.contactId,
            conversationId: ctx.conversationId, startsAt: new Date(a.inicio),
            customerName: a.nombre, notes: a.notas ?? null, now: ctx.now });
          return { ok: true, data: { id: cita.id, inicio: isoIn(cita.startsAt, timezone), estado: cita.status,
                                     etiqueta: labelFor(cita.startsAt, timezone) } };
        },
      },
      {
        name: 'cancelar_cita',
        description: 'Cancela una cita. Requiere confirmación explícita del usuario.',
        schema: z.object({
          cita_id: z.string().uuid(),
          confirmation_token: z.string().optional(),
          motivo: z.string().max(500).optional(),
        }),
        destructive: true,
        async run(a, ctx) {
          const expected = tokenFor(['cancelar_cita', a.cita_id, ctx.contactId]);
          const cita = await booking.findForContact(ctx.m, a.cita_id, ctx.contactId);
          if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
          if (a.confirmation_token === undefined) {
            const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
            return { ok: true, confirmationToken: expected,
                     data: { requiere_confirmacion: true, etiqueta: labelFor(cita.startsAt, timezone) } };
          }
          if (!sameToken(a.confirmation_token, expected)) return { ok: false, error: 'Token de confirmación inválido' };
          await booking.cancel(ctx.m, a.cita_id, ctx.contactId);
          return { ok: true, data: { cancelada: true } };
        },
      },
      {
        name: 'reprogramar_cita',
        description: 'Mueve una cita a otro horario. Requiere confirmación explícita del usuario.',
        schema: z.object({
          cita_id: z.string().uuid(),
          nuevo_inicio: isoWithOffset,
          confirmation_token: z.string().optional(),
        }),
        destructive: true,
        async run(a, ctx) {
          const nuevo = new Date(a.nuevo_inicio);
          const expected = tokenFor(['reprogramar_cita', a.cita_id, ctx.contactId, nuevo.toISOString()]);
          const cita = await booking.findForContact(ctx.m, a.cita_id, ctx.contactId);
          if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          if (a.confirmation_token === undefined) {
            // Se verifica ANTES de pedir confirmación: confirmar un horario que no
            // sirve haría que el usuario diga "sí" para recibir un error.
            const verdict = nuevo.getTime() === cita.startsAt.getTime() ? 'ok'
              : await availability.check(ctx.m, ctx.tenantId,
                  { serviceId: cita.serviceId, resourceId: cita.resourceId, start: nuevo, now: ctx.now });
            if (verdict !== 'ok' && verdict !== 'taken') return { ok: false, error: 'Ese horario no está disponible' };
            if (verdict === 'taken') return { ok: false, error: 'Esa franja ya está ocupada. Ofrece otro horario.' };
            return { ok: true, confirmationToken: expected,
                     data: { requiere_confirmacion: true, etiqueta: labelFor(nuevo, timezone) } };
          }
          if (!sameToken(a.confirmation_token, expected)) return { ok: false, error: 'Token de confirmación inválido' };
          const movida = await booking.reschedule(ctx.m, ctx.tenantId, a.cita_id, ctx.contactId, nuevo, ctx.now);
          return { ok: true, data: { id: movida.id, inicio: isoIn(movida.startsAt, timezone),
                                     etiqueta: labelFor(movida.startsAt, timezone) } };
        },
      },
    ];
  }
}
