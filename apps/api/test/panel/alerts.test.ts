import { describe, it, expect } from 'vitest';
import { alertsFor } from '../../src/panel/alerts';
import type { TenantSummary } from '../../src/cli/tenants';

const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const base = (over: Partial<TenantSummary> = {}): TenantSummary => ({
  slug: 'salon', name: 'Salón', status: 'active', phone: '+57 300', mode: 'cloud_api',
  channelStatus: 'active', historySync: 'not_applicable', channelCreatedAt: daysAgo(60),
  lastPhoneEcho: null, lastCustomer: daysAgo(1), syncs: {}, google: [], ai: null, failedOutbound24h: 0, ...over,
});
const sev = (s: TenantSummary) => alertsFor(s, NOW).map((a) => `${a.severity}:${a.area}`);

describe('avisos de un negocio', () => {
  it('un negocio sano no tiene avisos', () => {
    expect(alertsFor(base(), NOW)).toEqual([]);
  });

  it('canal desconectado o inactivo es crítico; sin canal en alta es solo info', () => {
    expect(sev(base({ channelStatus: 'disconnected' }))).toEqual(['critical:canal']);
    expect(sev(base({ channelStatus: 'inactive' }))).toEqual(['critical:canal']);
    expect(sev(base({ status: 'onboarding', channelStatus: null, mode: null }))).toEqual(['info:negocio', 'info:canal']);
    expect(sev(base({ channelStatus: null, mode: null }))).toEqual(['warning:canal']);
  });

  it('dueño en coexistencia: aviso a los 10 días sin ecos, crítico a los 14', () => {
    const coex = (d: number) => base({ mode: 'coexistence', lastPhoneEcho: daysAgo(d) });
    expect(sev(coex(9))).toEqual([]);
    expect(sev(coex(10))).toEqual(['warning:dueño']);
    expect(sev(coex(13))).toEqual(['warning:dueño']);
    expect(sev(coex(14))).toEqual(['critical:dueño']);
    expect(alertsFor(coex(14), NOW)[0].message).toContain('14 días');
  });

  it('si el dueño nunca escribió, cuenta desde que se conectó el número', () => {
    expect(sev(base({ mode: 'coexistence', channelCreatedAt: daysAgo(3) }))).toEqual([]);
    const never = alertsFor(base({ mode: 'coexistence', channelCreatedAt: daysAgo(15) }), NOW);
    expect(never.map((a) => a.severity)).toEqual(['critical']);
    expect(never[0].message).toContain('nunca');
  });

  it('en un número dedicado (cloud_api) no hay dueño que vigilar', () => {
    expect(sev(base({ mode: 'cloud_api', channelCreatedAt: daysAgo(90) }))).toEqual([]);
  });

  it('sincronización fallida o historial pendiente más de 24 h', () => {
    expect(sev(base({ mode: 'coexistence', lastPhoneEcho: daysAgo(1), syncs: { history: 'failed' } })))
      .toEqual(['warning:sincronización']);
    expect(sev(base({ mode: 'coexistence', lastPhoneEcho: daysAgo(1), historySync: 'pending', channelCreatedAt: daysAgo(2) })))
      .toEqual(['warning:sincronización']);
    expect(sev(base({ mode: 'coexistence', lastPhoneEcho: daysAgo(0.1), historySync: 'pending', channelCreatedAt: daysAgo(0.5) })))
      .toEqual([]);
  });

  it('Google: reconectar es crítico; sin calendario, avisos vencidos o con error y citas sin subir son avisos', () => {
    const g = (over: Partial<TenantSummary['google'][number]>) => base({ google: [{
      resource: 'maria', status: 'active', calendar: true, watchExpiresAt: daysAgo(-5).toISOString(), watchError: false, unsynced: 0, ...over }] });
    expect(sev(g({}))).toEqual([]);
    expect(sev(g({ status: 'needs_reauth' }))).toEqual(['critical:google']);
    expect(sev(g({ calendar: false }))).toEqual(['warning:google']);
    expect(sev(g({ watchExpiresAt: daysAgo(1).toISOString() }))).toEqual(['warning:google']);
    expect(sev(g({ watchError: true }))).toEqual(['warning:google']);
    expect(alertsFor(g({ unsynced: 3 }), NOW)[0].message).toContain('3 citas');
  });

  it('IA: agotada es aviso, desde el 80 % es info, apagada no avisa', () => {
    const ai = (spentUsd: number, enabled = true) => base({ ai: { enabled, model: 'claude-opus-5-5', spentUsd, budgetUsd: 20 } });
    expect(sev(ai(15.9))).toEqual([]);
    expect(sev(ai(16))).toEqual(['info:ia']);
    expect(sev(ai(20))).toEqual(['warning:ia']);
    expect(sev(ai(25, false))).toEqual([]);
  });

  it('mensajes que no salieron en 24 h son aviso', () => {
    expect(alertsFor(base({ failedOutbound24h: 2 }), NOW)).toEqual([
      expect.objectContaining({ severity: 'warning', area: 'envíos', message: expect.stringContaining('2 mensajes') })]);
  });

  it('ordena de lo más grave a lo menos grave', () => {
    const s = base({ status: 'suspended', channelStatus: 'disconnected', failedOutbound24h: 1 });
    expect(alertsFor(s, NOW).map((a) => a.severity)).toEqual(['critical', 'warning', 'info']);
  });
});
