import { z } from 'zod';
import { DateTime } from 'luxon';
import type { DataSource } from 'typeorm';
import type { FlowDefinition } from '@citara/shared';
import { AGENDA_FLOW } from '../flow-engine/flows/agenda';
import { setDefaultFlow } from './provision';

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;
const key = z.string().regex(/^[a-z0-9_-]{1,64}$/, 'clave: minúsculas, números, - y _');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora HH:MM');
const iso = z.string().refine((v) => DateTime.fromISO(v, { setZone: true }).isValid && /([+-]\d{2}:\d{2}|Z)$/.test(v),
  'fecha ISO-8601 con offset');
const hoursBlock = z.object({
  days: z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).min(1),
  start: hhmm,
  end: hhmm,
}).refine((b) => b.end > b.start, { message: 'end debe ser posterior a start' });
const flowSchema = z.object({ key: z.string(), entry: z.string(), steps: z.record(z.unknown()) })
  .refine((f) => f.entry in f.steps, { message: 'el paso de entrada del flujo no existe' });

export const tenantConfigSchema = z.object({
  tenant: z.string().min(1),
  name: z.string().min(1).optional(),
  timezone: z.string().refine((tz) => DateTime.local().setZone(tz).isValid, 'zona horaria IANA inválida').optional(),
  human_takeover_hours: z.number().int().min(1).max(168).optional(),
  booking: z.object({
    min_lead_minutes: z.number().int().min(0).optional(),
    horizon_days: z.number().int().min(1).max(365).optional(),
    slot_granularity_minutes: z.number().int()
      .refine((n) => [5, 10, 15, 20, 30, 60].includes(n), 'granularidad: 5, 10, 15, 20, 30 o 60').optional(),
  }).optional(),
  services: z.array(z.object({
    key, name: z.string().min(1),
    duration_min: z.number().int().positive(),
    buffer_min: z.number().int().min(0).default(0),
    price_cents: z.number().int().min(0).optional(),
  })).min(1),
  resources: z.array(z.object({
    key, name: z.string().min(1),
    services: z.array(key).min(1),
    hours: z.array(hoursBlock).optional(),
  })).min(1),
  hours: z.array(hoursBlock).min(1),
  time_off: z.array(z.object({ from: iso, to: iso, reason: z.string().optional(), resource: key.optional() }))
    .default([]),
  flow: z.union([z.literal('agenda'), flowSchema]).optional(),
}).superRefine((c, ctx) => {
  const services = new Set(c.services.map((s) => s.key));
  const resources = new Set(c.resources.map((r) => r.key));
  if (services.size !== c.services.length) ctx.addIssue({ code: 'custom', message: 'claves de servicio repetidas' });
  if (resources.size !== c.resources.length) ctx.addIssue({ code: 'custom', message: 'claves de recurso repetidas' });
  for (const r of c.resources) for (const s of r.services) {
    if (!services.has(s)) ctx.addIssue({ code: 'custom', message: `el recurso '${r.key}' presta '${s}', que no es un servicio` });
  }
  for (const t of c.time_off) {
    if (t.resource && !resources.has(t.resource)) ctx.addIssue({ code: 'custom', message: `ausencia de un recurso inexistente: '${t.resource}'` });
    if (new Date(t.to) <= new Date(t.from)) ctx.addIssue({ code: 'custom', message: 'una ausencia termina antes de empezar' });
  }
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

/** Aplica la configuración en UNA transacción, con la conexión admin. */
export async function applyTenantConfig(admin: DataSource, raw: unknown) {
  const parsed = tenantConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n'));
  }
  const c = parsed.data;

  return admin.transaction(async (m) => {
    const [tenant] = await m.query(`SELECT id FROM tenants WHERE slug = $1`, [c.tenant]);
    if (!tenant) throw new Error(`No existe el negocio '${c.tenant}'. Créalo primero (dev:provision o el alta).`);
    const tenantId: string = tenant.id;

    await m.query(
      `UPDATE tenants SET
         name = COALESCE($2, name), timezone = COALESCE($3, timezone),
         human_takeover_hours = COALESCE($4, human_takeover_hours),
         min_lead_minutes = COALESCE($5, min_lead_minutes), horizon_days = COALESCE($6, horizon_days),
         slot_granularity_minutes = COALESCE($7, slot_granularity_minutes)
       WHERE id = $1`,
      [tenantId, c.name ?? null, c.timezone ?? null, c.human_takeover_hours ?? null,
       c.booking?.min_lead_minutes ?? null, c.booking?.horizon_days ?? null, c.booking?.slot_granularity_minutes ?? null]);

    const serviceIds = new Map<string, string>();
    for (const s of c.services) {
      const [row] = await m.query(
        `INSERT INTO services (tenant_id, key, name, duration_min, buffer_min, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET name = EXCLUDED.name, duration_min = EXCLUDED.duration_min, buffer_min = EXCLUDED.buffer_min,
               price_cents = EXCLUDED.price_cents, active = true
         RETURNING id`, [tenantId, s.key, s.name, s.duration_min, s.buffer_min, s.price_cents ?? null]);
      serviceIds.set(s.key, row.id);
    }
    // Lo que ya no está se desactiva, nunca se borra: las citas lo referencian.
    await m.query(`UPDATE services SET active = false WHERE tenant_id = $1 AND NOT (key = ANY($2))`,
                  [tenantId, [...serviceIds.keys()]]);

    const resourceIds = new Map<string, string>();
    for (const r of c.resources) {
      const [row] = await m.query(
        `INSERT INTO resources (tenant_id, key, name) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name, active = true
         RETURNING id`, [tenantId, r.key, r.name]);
      resourceIds.set(r.key, row.id);
    }
    await m.query(`UPDATE resources SET active = false WHERE tenant_id = $1 AND NOT (key = ANY($2))`,
                  [tenantId, [...resourceIds.keys()]]);

    await m.query(`DELETE FROM resource_services WHERE tenant_id = $1`, [tenantId]);
    for (const r of c.resources) for (const s of r.services) {
      await m.query(`INSERT INTO resource_services (tenant_id, resource_id, service_id) VALUES ($1, $2, $3)`,
                    [tenantId, resourceIds.get(r.key), serviceIds.get(s)]);
    }

    await m.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
    let hours = 0;
    const insertHours = async (blocks: z.infer<typeof hoursBlock>[], resourceId: string | null) => {
      for (const b of blocks) for (const d of b.days) {
        await m.query(
          `INSERT INTO business_hours (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, resourceId, DAYS[d], b.start, b.end]);
        hours++;
      }
    };
    await insertHours(c.hours, null);
    for (const r of c.resources) if (r.hours) await insertHours(r.hours, resourceIds.get(r.key)!);

    await m.query(`DELETE FROM time_off WHERE tenant_id = $1`, [tenantId]);
    for (const t of c.time_off) {
      await m.query(
        `INSERT INTO time_off (tenant_id, resource_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, t.resource ? resourceIds.get(t.resource) : null, t.from, t.to, t.reason ?? null]);
    }

    let flow: string | null = null;
    if (c.flow) {
      const definition = (c.flow === 'agenda' ? AGENDA_FLOW : c.flow) as FlowDefinition;
      await setDefaultFlow(m, tenantId, definition, 'current');
      flow = definition.key;
    }

    return { tenantId, services: c.services.length, resources: c.resources.length,
             hours, timeOff: c.time_off.length, flow };
  });
}
