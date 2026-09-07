import type {
  FlowDefinition, FlowStep, SessionState, OutboundContent,
} from '@citara/shared';

const MAX_CHAIN = 20; // pasos encadenados sin input antes de declarar ciclo

export interface ExecResult {
  state: SessionState;
  outbound: OutboundContent[];
}

/** Interpola {{var}} con las variables de sesión; deja intacto lo no resuelto. */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

const norm = (s: string) => s.trim().toLowerCase();

/** Resuelve la entrada del usuario contra las opciones: id, título o posición. */
function matchChoice(
  buttons: { id: string; title: string; next: string }[],
  input: string,
): string | null {
  const value = norm(input);

  const byId = buttons.find((b) => norm(b.id) === value);
  if (byId) return byId.next;

  const byTitle = buttons.find((b) => norm(b.title) === value);
  if (byTitle) return byTitle.next;

  // Posición numérica: la degradación a texto numerado de MetaSender.
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (index >= 0 && index < buttons.length) return buttons[index].next;
  }

  return null;
}

function renderChoice(
  step: Extract<FlowStep, { type: 'choice' }>,
  vars: Record<string, string>,
): OutboundContent {
  const body = interpolate(step.text, vars);

  if (step.kind === 'interactive_list') {
    return {
      kind: 'list', body, button: 'Ver opciones',
      sections: [{
        title: 'Opciones',
        rows: step.buttons.map((b) => ({ id: b.id, title: b.title })),
      }],
    };
  }

  return { kind: 'buttons', body, buttons: step.buttons.map((b) => ({ id: b.id, title: b.title })) };
}

/**
 * Avanza la conversación un turno. Función PURA: no envía, no persiste, no consulta.
 */
export function advance(
  flow: FlowDefinition,
  state: SessionState | null,
  input: string | null,
): ExecResult {
  let current: SessionState = state ?? { stepKey: flow.entry, vars: {}, status: 'active' };
  const outbound: OutboundContent[] = [];

  for (let hops = 0; ; hops++) {
    if (hops >= MAX_CHAIN) {
      throw new Error(`Ciclo detectado en el flujo '${flow.key}' tras ${MAX_CHAIN} pasos`);
    }

    const step: FlowStep | undefined = flow.steps[current.stepKey];
    if (!step) throw new Error(`Paso inexistente: '${current.stepKey}' en flujo '${flow.key}'`);

    if (step.type === 'message') {
      outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      current = { ...current, stepKey: step.next };
      continue; // encadena sin esperar input
    }

    if (step.type === 'end') {
      if (step.text) outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      return { state: { ...current, status: 'ended' }, outbound };
    }

    if (step.type === 'choice') {
      // Sin input: es la primera vez que se llega al paso. Emitir el menú y esperar.
      if (input === null) {
        outbound.push(renderChoice(step, current.vars));
        return { state: current, outbound };
      }

      const next = matchChoice(step.buttons, input);
      if (next === null) {
        // No coincide: repetir el menú sin avanzar.
        // (En la Fase 4, ai_fallback interceptará justo aquí.)
        outbound.push(renderChoice(step, current.vars));
        return { state: current, outbound };
      }

      current = { ...current, stepKey: next };
      input = null; // el input ya se consumió; los siguientes pasos encadenan
      continue;
    }

    // El tipo capture se implementa en la tarea 13.
    return { state: current, outbound };
  }
}
