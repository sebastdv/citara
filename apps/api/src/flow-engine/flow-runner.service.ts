import { Inject, Injectable } from '@nestjs/common';
// Import de VALOR, no `import type`: FlowRunner es @Injectable() y recibe
// DataSource e InboundProcessor por constructor. Con emitDecoratorMetadata
// activo, un `import type` se borra en la emisión y el design:paramtype
// queda en `Object`, y Nest ya no puede resolver la dependencia. Cuarta vez
// que este defecto aparece en el plan (Tasks 8, 9, 10 y esta): ver la misma
// nota en inbound.processor.ts y outbound.processor.ts.
import { DataSource } from 'typeorm';
import type { OutboundContent, FlowDefinition, SessionState } from '@citara/shared';
import { advance } from './executor';
import { runInTenant } from '../tenancy/tenant-context';
import { InboundProcessor } from '../queues/inbound.processor';
import type { InboundJob } from '../queues/inbound.queue';
import { OutboundQueue } from '../queues/outbound.queue';
import type { OutboundJob } from '../queues/outbound.queue';

/**
 * Lo mínimo que FlowRunner necesita de la cola de salida: encolar un job.
 * Se separa de la clase concreta para que el arnés de pruebas conversacionales
 * pueda inyectar un doble en memoria (sin Redis, sin red) en vez de construir
 * un OutboundQueue real, que abre una conexión al arrancar.
 */
export interface OutboundEnqueuer {
  add(job: OutboundJob): unknown;
}

@Injectable()
export class FlowRunner {
  constructor(
    private readonly ds: DataSource,
    private readonly inbound: InboundProcessor,
    // @Inject explícito: el tipo estático del parámetro es la interfaz
    // mínima de arriba (para que el arnés pueda pasar un doble), así que
    // Nest no puede resolver la dependencia por tipo inferido — hay que
    // darle el token (la clase concreta registrada en AppModule).
    @Inject(OutboundQueue) private readonly outboundQueue: OutboundEnqueuer,
  ) {}

  async handle(job: InboundJob): Promise<OutboundContent[]> {
    const { conversationId, messageId } = await this.inbound.process(job);

    // messageId vacío = wamid duplicado, ya procesado. No responder de nuevo.
    if (!messageId) return [];

    return runInTenant(this.ds, job.tenantId, async (m) => {
      const [flowRow] = await m.query(
        `SELECT id, definition FROM flows
          WHERE is_active AND is_default LIMIT 1`,
      );
      if (!flowRow) return [];
      const flow = flowRow.definition as FlowDefinition;

      // `status <> 'ended'`, no `status = 'active'`: una sesión en traspaso a
      // humano ('handoff') sigue siendo LA sesión vigente de la conversación
      // — hay que encontrarla para que `advance()` la corte en seco (sin
      // salida), no para que se pierda y dispare un flujo nuevo desde el
      // saludo. Solo 'ended' significa "esta conversación ya cerró, la
      // próxima entrada abre una sesión nueva".
      //
      // ORDER BY updated_at (no `id`, que es un UUID sin orden temporal): una
      // conversación puede cerrar una sesión y abrir otra (lo permite el
      // índice parcial `WHERE status = 'active'` sobre conversation_sessions),
      // y ordenar por `id` devolvería una fila arbitraria, no la más reciente.
      const [sessionRow] = await m.query(
        `SELECT id, step_key, vars, status FROM conversation_sessions
          WHERE conversation_id = $1 AND status <> 'ended'
          ORDER BY updated_at DESC LIMIT 1`,
        [conversationId],
      );

      const state: SessionState | null = sessionRow
        ? { stepKey: sessionRow.step_key, vars: sessionRow.vars, status: sessionRow.status }
        : null;

      // Sesión nueva → sin input, para que el flujo emita su paso de entrada.
      const input = state ? job.message.text : null;
      const result = advance(flow, state, input);

      if (sessionRow) {
        await m.query(
          `UPDATE conversation_sessions
              SET step_key = $1, vars = $2, status = $3, updated_at = now()
            WHERE id = $4`,
          [result.state.stepKey, JSON.stringify(result.state.vars), result.state.status, sessionRow.id],
        );
      } else {
        await m.query(
          `INSERT INTO conversation_sessions
             (tenant_id, conversation_id, flow_id, step_key, vars, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [job.tenantId, conversationId, flowRow.id, result.state.stepKey,
           JSON.stringify(result.state.vars), result.state.status],
        );
      }

      for (const [i, content] of result.outbound.entries()) {
        // `type` con el MISMO vocabulario que el resto del sistema (ver la
        // nota idéntica en outbound.processor.ts, unificada en 2aba56a):
        // botones y lista son las dos formas de un mensaje interactivo, y el
        // panel de la fase 5 muestra la conversación entera en una lista
        // única — una columna cuyo significado dependiera de `direction`
        // sería una trampa. El `kind` fino no se pierde: viaja en `payload`.
        const type = content.kind === 'text' ? 'text' : 'interactive';

        // La fila se crea aquí, sin wamid: el mensaje ya existe en la
        // conversación aunque el envío todavía no haya ocurrido. El envío la
        // completa después con el wamid; no inserta otra.
        const [fila] = await m.query(
          `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, payload, status)
           VALUES ($1, $2, 'out', $3, $4, $5, 'pending')
           RETURNING id`,
          [job.tenantId, conversationId, type,
           'body' in content ? content.body : null, JSON.stringify({ ...content, seq: i })],
        );

        // Encolar además de persistir: el contrato de esta clase dice que
        // "persiste el estado nuevo y encola los mensajes de salida" — sin
        // esto, la OutboundQueue de la Task 10 queda muerta y nada llama
        // jamás a MetaSender en producción. La clave de idempotencia se
        // deriva del mensaje ENTRANTE y de la posición del saliente: si Meta
        // reentrega el mismo webhook, `messageId` se repite (misma fila) y
        // BullMQ no vuelve a encolar/enviar el mismo job.
        await this.outboundQueue.add({
          tenantId: job.tenantId,
          channelId: job.channelId,
          conversationId,
          messageId: fila.id,
          to: job.message.from,
          idempotencyKey: `${messageId}:${i}`,
          content,
        });
      }

      return result.outbound;
    });
  }
}
