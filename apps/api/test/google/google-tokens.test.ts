import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { GoogleApiError, GoogleAuthError } from '../../src/google/google.client';
import { GoogleTokens } from '../../src/google/google-tokens.service';

let enc: EncryptionService;
beforeAll(async () => { enc = new EncryptionService(process.env.DB_ENCRYPTION_KEY!); await enc.ready(); });

const setup = () => {
  const google = { refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ya29.uno', expiresIn: 3599 }) };
  const tokens = new GoogleTokens(enc, google as never);
  const account = { id: 'a1', refreshTokenEncrypted: enc.encrypt('1//refresh') };
  return { google, tokens, account };
};

describe('GoogleTokens', () => {
  it('renueva con el refresh token descifrado y reutiliza el access token mientras vive', async () => {
    const { google, tokens, account } = setup();
    expect(await tokens.accessToken(account)).toBe('ya29.uno');
    expect(await tokens.accessToken(account)).toBe('ya29.uno');
    expect(google.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(google.refreshAccessToken).toHaveBeenCalledWith('1//refresh');
  });

  it('un token a menos de un minuto de vencer se renueva', async () => {
    const { google, tokens, account } = setup();
    google.refreshAccessToken.mockResolvedValue({ accessToken: 'ya29.corto', expiresIn: 30 });
    await tokens.accessToken(account);
    await tokens.accessToken(account);
    expect(google.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('ante un 401 descarta el token y reintenta una vez', async () => {
    const { google, tokens, account } = setup();
    google.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: 'ya29.viejo', expiresIn: 3599 })
      .mockResolvedValueOnce({ accessToken: 'ya29.nuevo', expiresIn: 3599 });
    const fn = vi.fn()
      .mockRejectedValueOnce(new GoogleApiError('x: Google respondió 401', 401))
      .mockResolvedValueOnce('ok');
    expect(await tokens.withToken(account, fn)).toBe('ok');
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['ya29.viejo', 'ya29.nuevo']);
  });

  it('un acceso revocado se propaga como GoogleAuthError', async () => {
    const { google, tokens, account } = setup();
    google.refreshAccessToken.mockRejectedValue(new GoogleAuthError('renovación del token: invalid_grant'));
    await expect(tokens.withToken(account, async () => 'nunca')).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('si la cuenta se reconectó con otro refresh token, no reutiliza el access token del anterior', async () => {
    // Reconectar con otra cuenta de Google conserva el id de la fila: la caché del
    // worker devolvería el token de la cuenta vieja durante una hora.
    const { google, tokens, account } = setup();
    google.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: 'ya29.cuenta-x', expiresIn: 3599 })
      .mockResolvedValueOnce({ accessToken: 'ya29.cuenta-y', expiresIn: 3599 });
    expect(await tokens.accessToken(account)).toBe('ya29.cuenta-x');
    const reconectada = { id: account.id, refreshTokenEncrypted: enc.encrypt('1//otra-cuenta') };
    expect(await tokens.accessToken(reconectada)).toBe('ya29.cuenta-y');
  });
});
