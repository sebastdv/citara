import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDataSource } from '@citara/db';
import { FlowRunner } from '../../src/flow-engine/flow-runner.service';
import type { OutboundEnqueuer } from '../../src/flow-engine/flow-runner.service';
import { InboundProcessor } from '../../src/queues/inbound.processor';
import { runInTenant } from '../../src/tenancy/tenant-context';
import type { InboundMessage, OutboundContent } from '@citara/shared';
import type { OutboundJob } from '../../src/queues/outbound.queue';

let ds: DataSource | null = null;

/**
 * Cola de salida de mentira: solo registra en memoria lo que se le encoló.
 * El arnés es libre de red (sin Redis, sin WhatsApp), así que jamás se le
 * pasa a FlowRunner una OutboundQueue real — esta clase cumple la interfaz
 * mínima `OutboundEnqueuer` que FlowRunner necesita.
 */
class FakeOutboundQueue implements OutboundEnqueuer {
  readonly jobs: OutboundJob[] = [];
  add(job: OutboundJob) {
    this.jobs.push(job);
    return Promise.resolve();
  }
}

/**
 * Arnés de conversación: alimenta mensajes de usuario al motor y devuelve lo
 * que el bot habría enviado. Sin red, sin WhatsApp, sin colas.
 * Reutilizable por todas las fases siguientes.
 */
export class ConversationHarness {
  private lastWamid = '';

  private constructor(
    private readonly runner: FlowRunner,
    private readonly ctx: { tenantId: string; channelId: string; from: string },
  ) {}

  static async create(ctx: { tenantId: string; channelId: string; from: string }) {
    if (!ds) { ds = createDataSource(process.env.DATABASE_URL!); await ds.initialize(); }
    const runner = new FlowRunner(ds, new InboundProcessor(ds), new FakeOutboundQueue());
    return new ConversationHarness(runner, ctx);
  }

  static async teardown() { await ds?.destroy(); ds = null; }

  /** Simula que el usuario escribe texto. */
  say(text: string): Promise<OutboundContent[]> {
    return this.deliver(this.message({ type: 'text', text }));
  }

  /** Simula que el usuario pulsa un botón (Meta entrega el id, no el título). */
  tap(buttonId: string): Promise<OutboundContent[]> {
    return this.deliver(this.message({ type: 'interactive', text: buttonId }));
  }

  /** Reenvía el último mensaje con el mismo wamid, como haría un reintento de Meta. */
  replayLast(): Promise<OutboundContent[]> {
    return this.runner.handle({
      tenantId: this.ctx.tenantId, channelId: this.ctx.channelId,
      message: this.message({ type: 'text', text: 'repetido', wamid: this.lastWamid }),
    });
  }

  async sessionStatus(): Promise<string | null> {
    // ORDER BY updated_at (no `id`, que es un UUID sin orden temporal): ver
    // la misma nota en flow-runner.service.ts. Con una sola sesión por test
    // esto no se notaba, pero en cuanto una conversación cierre una sesión y
    // abra otra, `id DESC` devolvería una fila arbitraria.
    const [row] = await runInTenant(ds!, this.ctx.tenantId, (m) =>
      m.query(`SELECT status FROM conversation_sessions ORDER BY updated_at DESC LIMIT 1`));
    return row?.status ?? null;
  }

  async sessionVars(): Promise<Record<string, string>> {
    const [row] = await runInTenant(ds!, this.ctx.tenantId, (m) =>
      m.query(`SELECT vars FROM conversation_sessions ORDER BY updated_at DESC LIMIT 1`));
    return row?.vars ?? {};
  }

  async messageCount(): Promise<number> {
    const [row] = await runInTenant(ds!, this.ctx.tenantId, (m) =>
      m.query(`SELECT count(*)::int AS n FROM messages`));
    return row.n;
  }

  private message(over: Partial<InboundMessage> & { type: InboundMessage['type'] }): InboundMessage {
    const wamid = over.wamid ?? `wamid.${randomUUID()}`;
    this.lastWamid = wamid;
    return {
      wamid, phoneNumberId: '106540', wabaId: '102290',
      from: this.ctx.from, profileName: 'Ana',
      text: null, mediaId: null, timestamp: new Date(), raw: {}, ...over, type: over.type,
    };
  }

  private deliver(message: InboundMessage) {
    return this.runner.handle({
      tenantId: this.ctx.tenantId, channelId: this.ctx.channelId, message,
    });
  }
}
