import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '../../src/whatsapp/signature';

const SECRET = 'app-secret-de-prueba';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
const valid = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

describe('verifyMetaSignature', () => {
  it('acepta una firma válida', () => {
    expect(verifyMetaSignature(body, valid, SECRET)).toBe(true);
  });

  it('rechaza una firma con secreto equivocado', () => {
    const bad = 'sha256=' + createHmac('sha256', 'otro').update(body).digest('hex');
    expect(verifyMetaSignature(body, bad, SECRET)).toBe(false);
  });

  it('rechaza si el cuerpo cambió aunque sea un byte', () => {
    const tampered = Buffer.from(JSON.stringify({ object: 'otra_cosa' }));
    expect(verifyMetaSignature(tampered, valid, SECRET)).toBe(false);
  });

  it('rechaza cuando falta el header', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rechaza un header sin el prefijo sha256=', () => {
    expect(verifyMetaSignature(body, 'abc123', SECRET)).toBe(false);
  });

  it('rechaza un header de longitud distinta sin lanzar', () => {
    expect(verifyMetaSignature(body, 'sha256=deadbeef', SECRET)).toBe(false);
  });
});
