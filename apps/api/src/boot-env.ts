/**
 * Lo que la API revisa del entorno al arrancar. Un PUBLIC_BASE_URL roto rompe
 * las cookies del panel, el origen que se exige en sus POST y la dirección de
 * los avisos de Google: mejor no arrancar que fallar de a poco. Sin los IDs de
 * Meta solo deja de servir la página de conexión, así que es un aviso.
 */
export function bootEnvCheck(
  env: NodeJS.ProcessEnv,
  /** El worker no sirve la página de conexión: no le tocan los IDs de Meta. */
  opts: { meta?: boolean } = {},
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === 'production';

  const base = env.PUBLIC_BASE_URL;
  if (!base) {
    if (production) errors.push('falta PUBLIC_BASE_URL (la URL pública, p. ej. https://citas.ejemplo.com)');
  } else {
    let url: URL | null = null;
    try { url = new URL(base); } catch { /* abajo */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      errors.push(`PUBLIC_BASE_URL no es una URL http(s): '${base}'`);
    } else if (url.pathname.replace(/\/$/, '') !== '' || url.search || url.hash) {
      errors.push(`PUBLIC_BASE_URL debe ser solo el origen, sin ruta: '${base}'`);
    } else if (production && url.protocol !== 'https:') {
      errors.push(`PUBLIC_BASE_URL debe ser https en producción: '${base}'`);
    }
  }

  for (const name of opts.meta === false ? [] : ['META_APP_ID', 'META_ES_CONFIG_ID'] as const) {
    const v = env[name];
    if (!v) warnings.push(`falta ${name}: la página para conectar WhatsApp no va a funcionar`);
    else if (!/^\d+$/.test(v)) errors.push(`${name} debe ser numérico (es el id que muestra Meta): '${v}'`);
  }
  return { errors, warnings };
}
