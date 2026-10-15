import { describe, it, expect } from 'vitest';
import { bootEnvCheck } from '../src/boot-env';

const META = { META_APP_ID: '1234567890', META_ES_CONFIG_ID: '987654321' };

describe('bootEnvCheck', () => {
  it('en producción exige un PUBLIC_BASE_URL https y solo de origen', () => {
    const prod = (PUBLIC_BASE_URL?: string) => bootEnvCheck({ NODE_ENV: 'production', PUBLIC_BASE_URL, ...META }).errors;
    expect(prod('https://citas.ejemplo.com')).toEqual([]);
    expect(prod('https://citas.ejemplo.com/')).toEqual([]);
    expect(prod(undefined)).toEqual([expect.stringContaining('falta PUBLIC_BASE_URL')]);
    expect(prod('http://citas.ejemplo.com')).toEqual([expect.stringContaining('https')]);
    expect(prod('https://citas.ejemplo.com/panel')).toEqual([expect.stringContaining('sin ruta')]);
    expect(prod('citas.ejemplo.com')).toEqual([expect.stringContaining('no es una URL')]);
  });

  it('en desarrollo acepta http y que falte', () => {
    expect(bootEnvCheck({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:3000', ...META }).errors).toEqual([]);
    expect(bootEnvCheck({ NODE_ENV: 'development', ...META }).errors).toEqual([]);
  });

  it('sin los IDs de Meta avisa; con un ID que no es número no arranca', () => {
    const sin = bootEnvCheck({ PUBLIC_BASE_URL: 'http://localhost:3000' });
    expect(sin.errors).toEqual([]);
    expect(sin.warnings).toEqual([expect.stringContaining('META_APP_ID'), expect.stringContaining('META_ES_CONFIG_ID')]);
    expect(bootEnvCheck({ META_APP_ID: 'mi-app', META_ES_CONFIG_ID: '1' }).errors)
      .toEqual([expect.stringContaining('META_APP_ID debe ser numérico')]);
    expect(bootEnvCheck({}, { meta: false })).toEqual({ errors: [], warnings: [] });
  });
});
