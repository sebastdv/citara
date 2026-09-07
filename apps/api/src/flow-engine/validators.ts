export type ValidatorKind = 'text' | 'number' | 'email';
export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateInput(kind: ValidatorKind, raw: string): ValidationResult {
  const value = raw.trim();

  switch (kind) {
    case 'text':
      return value.length > 0
        ? { ok: true, value }
        : { ok: false, reason: 'vacío' };

    case 'number':
      return /^\d+$/.test(value)
        ? { ok: true, value }
        : { ok: false, reason: 'no es un número' };

    case 'email': {
      const lower = value.toLowerCase();
      return EMAIL.test(lower)
        ? { ok: true, value: lower }
        : { ok: false, reason: 'email inválido' };
    }

    default:
      // Las definiciones de flujo son jsonb escrito por el tenant, no código
      // verificado por el compilador: un `validate` desconocido debe fallar
      // con un mensaje que lo nombre, no reventar con un TypeError opaco.
      return { ok: false, reason: `validador desconocido: '${kind as string}'` };
  }
}
