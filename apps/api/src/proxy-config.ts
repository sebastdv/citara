/**
 * Cómo interpretar X-Forwarded-For. Detrás de Caddy, TRUST_PROXY=1 hace que el
 * límite de intentos del panel vea la IP del cliente. Sin él, detrás de https
 * todas las peticiones cuentan como la IP del proxy: cinco fallos de cualquiera
 * bloquearían al operador. No se adivina; se avisa al arrancar.
 */
export function trustProxySetting(env: NodeJS.ProcessEnv): { value?: number | string; warning?: string } {
  const v = env.TRUST_PROXY;
  if (v) return { value: /^\d+$/.test(v) ? Number(v) : v };
  if ((env.PUBLIC_BASE_URL ?? '').startsWith('https://')) {
    return { warning: 'PUBLIC_BASE_URL es https pero falta TRUST_PROXY: detrás de un proxy, el límite de intentos del panel contará a todos como la IP del proxy (pon TRUST_PROXY=1).' };
  }
  return {};
}
