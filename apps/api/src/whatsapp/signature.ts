import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifica el header `x-hub-signature-256` de Meta contra el cuerpo CRUDO.
 * Debe recibir el Buffer sin parsear: cualquier reserialización del JSON
 * cambia bytes y rompe la firma.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');

  // timingSafeEqual lanza si difieren en longitud: comparar antes.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
