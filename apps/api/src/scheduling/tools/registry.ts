import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
// Imports de VALOR: ToolRegistry es @Injectable() y Nest los resuelve por tipo.
import { AvailabilityService } from '../availability.service';
import { BookingService } from '../booking.service';
import { SchedulingError, SlotTakenError } from '../scheduling.errors';
import { dayLabelFor, hourFor, isoIn, labelFor } from '../format';

export interface ToolContext {
  /** La transacción del turno: RLS fijado y la conversación bloqueada. */
  m: EntityManager;
  tenantId: string;
  contactId: string;
  conversationId: string;
  now: Date;
  /** El entrante que se está atendiendo. Un token de confirmación no vale en el turno que lo emitió. */
  turnId?: string;
  /** 'agent': agendar también exige confirmación. Por defecto 'flow'. */
  actor?: 'flow' | 'agent';
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
const day = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v).isValid,
  'Fecha inválida: se espera AAAA-MM-DD');
/** Un rango de consulta nunca pasa de esto: la transacción del turno está abierta mientras se calcula. */
const MAX_RANGE_DAYS = 31;
const instant = (iso: string) => DateTime.fromISO(iso, { setZone: true }).toJSDate();

/** Lo que dura una confirmación: más que eso, la persona ya está en otra cosa. */
export const CONFIRMATION_TTL_MS = 30 * 60_000;

/**
 * Token de confirmación (R4) ligado a la herramienta, la cita, quien pregunta,
 * lo que se va a aplicar, el turno en que se pidió y cuándo. Sin estado que
 * guardar: `<emitido>.<turno>.<mac>`. Llave derivada, no la de cifrado tal cual.
 */
function issueToken(parts: string[], ctx: ToolContext): string {
  const issued = String(Math.floor(ctx.now.getTime() / 1000));
  const turn = ctx.turnId ?? '-';
  return `${issued}.${turn}.${macFor([...parts, issued, turn])}`;
}

/** null si sirve; si no, el motivo para el modelo o el menú. */
function checkToken(given: string | undefined, parts: string[], ctx: ToolContext): string | null {
  const [issued, turn, mac] = (given ?? '').split('.');
  if (!issued || !turn || !mac || !sameMac(mac, macFor([...parts, issued, turn]))) {
    return 'Token de confirmación inválido';
  }
  if (ctx.now.getTime() - Number(issued) * 1000 > CONFIRMATION_TTL_MS) {
    return 'La confirmación venció: vuelve a pedirla';
  }
  // La confirmación la da la persona en un mensaje posterior, no el mismo turno que la pidió.
  if (ctx.turnId && turn === ctx.turnId) return 'Falta que la persona confirme en su próximo mensaje';
  return null;
}

function macFor(parts: string[]): string {
  const key = createHmac('sha256', process.env.DB_ENCRYPTION_KEY!).update('citara/tool-confirmation').digest();
  return createHmac('sha256', key).update(parts.join('|')).digest('hex').slice(0, 32);
}
function sameMac(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
      if (err instanceof SlotTakenError) return { ok: false, error: 'Esa franja ya está ocupada' };
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
          /** Minutos mínimos entre dos horas ofrecidas: reparte la lista por todo el día. */
          espaciado_min: z.coerce.number().int().min(0).max(240).default(0),
        }),
        destructive: false,
        async run(a, ctx) {
          const { timezone, horizonDays } = await availability.settings(ctx.m, ctx.tenantId);
          const desde = a.desde ? DateTime.fromISO(a.desde, { zone: timezone })
                                : DateTime.fromJSDate(ctx.now).setZone(timezone);
          const pedido = a.hasta ? DateTime.fromISO(a.hasta, { zone: timezone }) : desde.plus({ days: 6 });
          if (pedido < desde.startOf('day')) return { ok: false, error: 'El rango de fechas está invertido' };
          // R1: el rango se acota al horizonte del negocio y a un máximo fijo.
          const tope = DateTime.min(
            desde.plus({ days: MAX_RANGE_DAYS }),
            DateTime.fromJSDate(ctx.now).setZone(timezone).plus({ days: horizonDays }));
          const hasta = DateTime.min(pedido, tope);

          const slots = await availability.slotsFor(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id ?? null,
            from: desde.startOf('day').toJSDate(), to: hasta.endOf('day').toJSDate(), now: ctx.now });
          const spaced: typeof slots = [];
          for (const x of slots) {
            const last = spaced.at(-1);
            if (!last || x.start.getTime() >= last.start.getTime() + a.espaciado_min * 60_000) spaced.push(x);
          }
          return {
            ok: true,
            data: spaced.slice(0, a.limite).map((x) => ({
              inicio: isoIn(x.start, timezone), fin: isoIn(x.end, timezone), hora: hourFor(x.start, timezone),
              recurso_id: x.resourceId, recurso: x.resourceName, etiqueta: labelFor(x.start, timezone),
            })),
          };
        },
      },
      {
        name: 'consultar_dias',
        description: 'Próximos días con horarios libres para un servicio.',
        schema: z.object({
          servicio_id: z.string().uuid(),
          recurso_id: z.string().uuid().optional(),
          dias: z.coerce.number().int().min(1).max(14).default(7),
        }),
        destructive: false,
        async run(a, ctx) {
          const { timezone, horizonDays } = await availability.settings(ctx.m, ctx.tenantId);
          const hoy = DateTime.fromJSDate(ctx.now).setZone(timezone).startOf('day');
          const hasta = DateTime.min(hoy.plus({ days: MAX_RANGE_DAYS }),
                                     DateTime.fromJSDate(ctx.now).setZone(timezone).plus({ days: horizonDays }));
          const slots = await availability.slotsFor(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id ?? null,
            from: hoy.toJSDate(), to: hasta.endOf('day').toJSDate(), now: ctx.now });
          const porDia = new Map<string, { fecha: string; etiqueta: string; franjas: number }>();
          for (const x of slots) {
            const fecha = DateTime.fromJSDate(x.start).setZone(timezone).toISODate()!;
            const d = porDia.get(fecha) ?? { fecha, etiqueta: dayLabelFor(x.start, timezone), franjas: 0 };
            d.franjas++;
            porDia.set(fecha, d);
          }
          return { ok: true, data: [...porDia.values()].slice(0, a.dias) };
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
        description: 'Reserva una cita en una franja disponible. Para el asistente, requiere confirmación explícita del usuario.',
        schema: z.object({
          servicio_id: z.string().uuid(),
          recurso_id: z.string().uuid(),
          inicio: isoWithOffset,
          nombre: z.string().trim().min(1).max(255),
          notas: z.string().max(1000).optional(),
          confirmation_token: z.string().optional(),
        }),
        destructive: false,
        async run(a, ctx) {
          const startsAt = instant(a.inicio);
          if (ctx.actor === 'agent') {
            // El agente no reserva sin un "sí" de la persona en un mensaje posterior.
            const parts = ['agendar_cita', ctx.contactId, a.servicio_id, a.recurso_id, startsAt.toISOString(), a.nombre];
            if (a.confirmation_token === undefined) {
              const verdict = await availability.check(ctx.m, ctx.tenantId,
                { serviceId: a.servicio_id, resourceId: a.recurso_id, start: startsAt, now: ctx.now });
              if (verdict === 'taken') return { ok: false, error: 'Esa franja ya está ocupada' };
              if (verdict !== 'ok') return { ok: false, error: 'Ese horario no está disponible' };
              const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
              return { ok: true, confirmationToken: issueToken(parts, ctx),
                       data: { requiere_confirmacion: true, etiqueta: labelFor(startsAt, timezone) } };
            }
            const invalid = checkToken(a.confirmation_token, parts, ctx);
            if (invalid) return { ok: false, error: invalid };
          }
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          const cita = await booking.book(ctx.m, ctx.tenantId, {
            serviceId: a.servicio_id, resourceId: a.recurso_id, contactId: ctx.contactId,
            conversationId: ctx.conversationId, startsAt,
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
          const parts = ['cancelar_cita', a.cita_id, ctx.contactId];
          const cita = await booking.findForContact(ctx.m, a.cita_id, ctx.contactId);
          if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
          if (a.confirmation_token === undefined) {
            const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
            return { ok: true, confirmationToken: issueToken(parts, ctx),
                     data: { requiere_confirmacion: true, etiqueta: labelFor(cita.startsAt, timezone) } };
          }
          const invalid = checkToken(a.confirmation_token, parts, ctx);
          if (invalid) return { ok: false, error: invalid };
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
          const nuevo = instant(a.nuevo_inicio);
          const parts = ['reprogramar_cita', a.cita_id, ctx.contactId, nuevo.toISOString()];
          const cita = await booking.findForContact(ctx.m, a.cita_id, ctx.contactId);
          if (!cita) return { ok: false, error: 'No encontré esa cita a tu nombre' };
          const { timezone } = await availability.settings(ctx.m, ctx.tenantId);
          if (a.confirmation_token === undefined) {
            // Se verifica ANTES de pedir confirmación: confirmar un horario que no
            // sirve haría que el usuario diga "sí" para recibir un error.
            const verdict = await availability.check(ctx.m, ctx.tenantId, {
              serviceId: cita.serviceId, resourceId: cita.resourceId, start: nuevo, now: ctx.now,
              excludeAppointmentId: cita.id });
            if (verdict !== 'ok' && verdict !== 'taken') return { ok: false, error: 'Ese horario no está disponible' };
            if (verdict === 'taken') return { ok: false, error: 'Esa franja ya está ocupada' };
            return { ok: true, confirmationToken: issueToken(parts, ctx),
                     data: { requiere_confirmacion: true, etiqueta: labelFor(nuevo, timezone) } };
          }
          const invalid = checkToken(a.confirmation_token, parts, ctx);
          if (invalid) return { ok: false, error: invalid };
          const movida = await booking.reschedule(ctx.m, ctx.tenantId, a.cita_id, ctx.contactId, nuevo, ctx.now);
          return { ok: true, data: { id: movida.id, inicio: isoIn(movida.startsAt, timezone),
                                     etiqueta: labelFor(movida.startsAt, timezone) } };
        },
      },
    ];
  }
}
