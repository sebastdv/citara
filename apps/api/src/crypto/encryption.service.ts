import sodium from 'libsodium-wrappers';

const VERSION = 1;
const NONCE_BYTES = 24; // crypto_secretbox_NONCEBYTES
const KEY_BYTES = 32;   // crypto_secretbox_KEYBYTES

export class EncryptionService {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`DB_ENCRYPTION_KEY debe medir 32 bytes, midió ${key.length}`);
    }
    this.key = key;
  }

  async ready(): Promise<void> {
    await sodium.ready;
  }

  encrypt(plain: string): Buffer {
    const nonce = sodium.randombytes_buf(NONCE_BYTES);
    const cipher = sodium.crypto_secretbox_easy(
      sodium.from_string(plain), nonce, this.key,
    );
    return Buffer.concat([Buffer.from([VERSION]), Buffer.from(nonce), Buffer.from(cipher)]);
  }

  decrypt(envelope: Buffer): string {
    const version = envelope[0];
    if (version !== VERSION) {
      throw new Error(`Versión de envelope no soportada: ${version}`);
    }
    const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
    const cipher = envelope.subarray(1 + NONCE_BYTES);
    const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, this.key);
    return sodium.to_string(plain);
  }
}
