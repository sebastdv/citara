import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { EncryptionService } from '../crypto/encryption.service';
import { GoogleApiError, GoogleClient } from './google.client';

export interface GoogleAccountRef { id: string; refreshTokenEncrypted: Buffer }

/** Un minuto de margen: un token a punto de vencer fallaría a mitad de la llamada. */
const MARGIN_SECONDS = 60;

/**
 * Access tokens en memoria, por cuenta. Viven ~1 h; el refresh token cifrado
 * es lo único que se guarda. Cada proceso (API, worker) tiene su caché.
 */
@Injectable()
export class GoogleTokens {
  /** Por cuenta; `minted` dice con qué refresh token se obtuvo el access token. */
  private readonly cache = new Map<string, { token: string; expiresAt: number; minted: string }>();

  constructor(private readonly enc: EncryptionService, private readonly google: GoogleClient) {}

  async accessToken(account: GoogleAccountRef): Promise<string> {
    // Reconectar (quizá con otra cuenta de Google) conserva el id de la fila pero
    // cambia el refresh token: un access token del anterior ya no corresponde.
    const minted = createHash('sha256').update(account.refreshTokenEncrypted).digest('hex');
    const hit = this.cache.get(account.id);
    if (hit && hit.minted === minted && hit.expiresAt > Date.now()) return hit.token;
    const r = await this.google.refreshAccessToken(this.enc.decrypt(account.refreshTokenEncrypted));
    this.cache.set(account.id,
      { token: r.accessToken, expiresAt: Date.now() + (r.expiresIn - MARGIN_SECONDS) * 1000, minted });
    return r.accessToken;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  /** Con un 401 (token revocado o vencido antes de tiempo), se renueva y se reintenta una vez. */
  async withToken<T>(account: GoogleAccountRef, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.accessToken(account));
    } catch (err) {
      if (!(err instanceof GoogleApiError) || err.status !== 401) throw err;
      this.invalidate(account.id);
      return fn(await this.accessToken(account));
    }
  }
}
