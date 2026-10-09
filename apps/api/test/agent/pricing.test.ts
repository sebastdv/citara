import { describe, it, expect } from 'vitest';
import { usdFor } from '../../src/agent/pricing';

describe('usdFor', () => {
  it('cobra entrada, salida, lectura y escritura de caché con los precios de Opus 5.5', () => {
    // 1.000 sin caché × $4 + 500 de salida × $20 + 10.000 leídos × $0,20 + 2.000 escritos × $5, por millón.
    expect(usdFor('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500,
      cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000 })).toBeCloseTo(0.004 + 0.01 + 0.002 + 0.01, 9);
  });

  it('Haiku 5.5 es mucho más barato', () => {
    expect(usdFor('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 100 })).toBeCloseTo(0.0001 + 0.00005, 9);
  });

  it('un modelo sin precio conocido es un error, no un costo de cero', () => {
    expect(() => usdFor('claude-inventado', { input_tokens: 1, output_tokens: 1 })).toThrow(/precio/);
  });
});
