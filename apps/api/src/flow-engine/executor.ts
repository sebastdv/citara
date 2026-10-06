import type {
  FlowDefinition, FlowStep, SessionState, OutboundContent,
} from '@citara/shared';
import { validateInput } from './validators';

const MAX_CHAIN = 20; // pasos encadenados sin input antes de declarar ciclo

export interface ExecResult {
  state: SessionState;
  outbound: OutboundContent[];
  /** Intención de invocar una herramienta. El ejecutor sigue siendo PURO: no la ejecuta. */
  pending?: { tool: string; args: Record<string, string>; stepKey: string };
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

  // Una conversación en manos de un humano no recibe respuestas del bot.
  if (current.status === 'handoff') {
    return { state: current, outbound: [] };
  }

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

    if (step.type === 'capture') {
      // Sin input: es la primera vez que se llega al paso. Preguntar y esperar.
      if (input === null) {
        outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
        return { state: current, outbound };
      }

      const result = validateInput(step.validate ?? 'text', input);

      if (!result.ok) {
        if (step.on_invalid) {
          current = { ...current, stepKey: step.on_invalid };
          input = null;
          continue;
        }
        // Sin salida definida: repetir la pregunta sin avanzar.
        outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
        return { state: current, outbound };
      }

      // Se acumula sobre las variables existentes: no pisar lo capturado antes.
      current = {
        ...current,
        vars: { ...current.vars, [step.var]: result.value },
        stepKey: step.next,
      };
      input = null; // el input ya se consumió; los siguientes pasos encadenan
      continue;
    }

    if (step.type === 'tool') {
      const args = Object.fromEntries(
        Object.entries(step.args).map(([k, v]) => [k, interpolate(v, current.vars)]));
      return { state: current, outbound, pending: { tool: step.tool, args, stepKey: current.stepKey } };
    }

    if (step.type === 'pick') {
      const options: Record<string, unknown>[] = JSON.parse(current.vars[`__${step.from}`] ?? '[]');
      const index = input !== null && /^\d+$/.test(input.trim()) ? Number(input.trim()) - 1 : -1;
      if (index < 0 || index >= options.length) {
        // Sin input (primera vez) o fuera de la lista: mostrar o repetir la pregunta.
        outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
        return { state: current, outbound };
      }
      const chosen = options[index];
      const fields = Object.fromEntries(
        Object.entries(chosen).map(([k, v]) => [`${step.var}_${k}`, String(v)]));
      current = {
        ...current,
        vars: { ...current.vars, ...fields, [step.var]: String(chosen.id ?? chosen.inicio ?? '') },
        stepKey: step.next,
      };
      input = null;
      continue;
    }

    if (step.type === 'handoff') {
      if (step.text) outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      return { state: { ...current, status: 'handoff' }, outbound };
    }

    // Todos los tipos de paso están cubiertos arriba.
    return { state: current, outbound };
  }
}
