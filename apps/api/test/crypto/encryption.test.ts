import { describe, it, expect, beforeAll } from 'vitest';
import { EncryptionService } from '../../src/crypto/encryption.service';

let svc: EncryptionService;

beforeAll(async () => {
  // 32 bytes en base64
  const key = Buffer.alloc(32, 7).toString('base64');
  svc = new EncryptionService(key);
  await svc.ready();
});

describe('EncryptionService', () => {
  it('cifra y descifra ida y vuelta', () => {
    const secret = 'EAAG...token-de-meta';
    const envelope = svc.encrypt(secret);
    expect(svc.decrypt(envelope)).toBe(secret);
  });

  it('nunca produce el mismo cifrado dos veces (nonce aleatorio)', () => {
    const a = svc.encrypt('mismo-valor');
    const b = svc.encrypt('mismo-valor');
    expect(a.equals(b)).toBe(false);
  });

  it('marca la versión del envelope en el primer byte', () => {
    expect(svc.encrypt('x')[0]).toBe(1);
  });

  it('rechaza un envelope alterado', () => {
    const envelope = svc.encrypt('x');
    envelope[envelope.length - 1] ^= 0xff;
    expect(() => svc.decrypt(envelope)).toThrow();
  });

  it('rechaza una llave que no mida 32 bytes', () => {
    expect(() => new EncryptionService(Buffer.alloc(16).toString('base64')))
      .toThrow(/32 bytes/);
  });
});
