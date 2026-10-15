import { describe, it, expect } from 'vitest';
import { trustProxySetting } from '../src/proxy-config';

describe('TRUST_PROXY', () => {
  it('un número es la cantidad de saltos; otra cosa se pasa tal cual', () => {
    expect(trustProxySetting({ TRUST_PROXY: '1' })).toEqual({ value: 1 });
    expect(trustProxySetting({ TRUST_PROXY: 'loopback' })).toEqual({ value: 'loopback' });
  });
  it('sin TRUST_PROXY detrás de https avisa: todos contarían como la IP del proxy', () => {
    expect(trustProxySetting({ PUBLIC_BASE_URL: 'https://citas.ejemplo.co' }))
      .toEqual({ warning: expect.stringContaining('TRUST_PROXY') });
  });
  it('en local (http) sin TRUST_PROXY no avisa', () => {
    expect(trustProxySetting({ PUBLIC_BASE_URL: 'http://localhost:3000' })).toEqual({});
    expect(trustProxySetting({})).toEqual({});
  });
});
