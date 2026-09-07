import { describe, it, expect } from 'vitest';
import { canSendFreeform } from '../../src/conversations/session-window';

const now = new Date('2026-09-03T15:00:00Z');

describe('canSendFreeform', () => {
  it('permite texto libre dentro de las 24 horas', () => {
    expect(canSendFreeform(new Date('2026-09-03T14:00:00Z'), now)).toBe(true);
  });

  it('permite justo antes del límite (23h 59m)', () => {
    expect(canSendFreeform(new Date('2026-09-02T15:01:00Z'), now)).toBe(true);
  });

  it('bloquea exactamente a las 24 horas', () => {
    expect(canSendFreeform(new Date('2026-09-02T15:00:00Z'), now)).toBe(false);
  });

  it('bloquea pasadas las 24 horas', () => {
    expect(canSendFreeform(new Date('2026-09-01T15:00:00Z'), now)).toBe(false);
  });

  it('bloquea si nunca hubo mensaje entrante', () => {
    expect(canSendFreeform(null, now)).toBe(false);
  });
});
