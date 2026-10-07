export type SyncType = 'smb_app_state_sync' | 'history';

/** Un paso del alta que Meta no completó. El mensaje es apto para logs: sin token ni secreto. */
export class MetaOnboardingError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'MetaOnboardingError';
  }
}

const TIMEOUT_MS = 15_000;

/**
 * Las llamadas a la Graph API que hace el alta (spec §8). Este es el único
 * lugar que conoce esos endpoints. VERIFICAR la versión vigente de la Graph API
 * en la consola de Meta (META_GRAPH_VERSION).
 */
export class MetaOnboardingClient {
  constructor(
    private readonly graphVersion: string,
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /** Canjea el `code` del Embedded Signup por el token del negocio. */
  async exchangeCode(code: string): Promise<string> {
    const json = await this.call<{ access_token?: string }>('canje del código',
      this.url('oauth/access_token', { client_id: this.appId, client_secret: this.appSecret, code }));
    if (!json?.access_token) throw new MetaOnboardingError('canje del código: Meta no devolvió token', 200);
    return json.access_token;
  }

  /** El evento de coexistencia solo trae la cuenta (WABA): el número se consulta aquí. */
  async phoneNumbers(wabaId: string, token: string) {
    const json = await this.call<{ data?: { id: string; display_phone_number?: string }[] }>(
      'números de la cuenta', this.url(`${wabaId}/phone_numbers`, { fields: 'id,display_phone_number' }),
      { headers: { Authorization: `Bearer ${token}` } });
    return (json?.data ?? []).map((p) => ({ id: String(p.id), displayPhoneNumber: p.display_phone_number ?? null }));
  }

  /** Sin esto, los webhooks de la cuenta del negocio no llegan a la app. */
  async subscribeApp(wabaId: string, token: string): Promise<void> {
    await this.call('suscripción a los webhooks', this.url(`${wabaId}/subscribed_apps`),
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  }

  /** Una vez por tipo, dentro de las 24 h siguientes al alta. */
  async requestSync(phoneNumberId: string, token: string, syncType: SyncType): Promise<void> {
    await this.call(`sincronización ${syncType}`, this.url(`${phoneNumberId}/smb_app_data`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
    });
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(`https://graph.facebook.com/${this.graphVersion}/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async call<T>(what: string, url: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // Solo el nombre del error: el mensaje de un fallo de red puede traer la
      // URL, y la del canje lleva el secreto de la app.
      throw new MetaOnboardingError(`${what}: fallo de red (${(err as Error).name})`, null);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = typeof json?.error?.message === 'string' ? ` — ${json.error.message}` : '';
      throw new MetaOnboardingError(`${what}: Meta respondió ${res.status}${detail}`, res.status);
    }
    return json as T;
  }
}
