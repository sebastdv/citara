import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const AGENT_QUEUE = 'agent';

/** Lo que el worker del agente necesita: la conversación y el entrante que la derivó. */
export interface AgentJob {
  tenantId: string; channelId: string; conversationId: string; contactId: string;
  inboundId: string; to: string; kind: 'agent' | 'interpret'; stepKey: string; input?: string;
}
export interface AgentEnqueuer { add(job: AgentJob): unknown }

/** Spec §3.4: los turnos con LLM van por su propia cola, fuera de la transacción del turno. */
@Injectable()
export class AgentQueue implements AgentEnqueuer, OnModuleDestroy {
  private readonly queue = new Queue<AgentJob>(AGENT_QUEUE, {
    connection: { url: process.env.REDIS_URL },
    defaultJobOptions: {
      // Los fallos del modelo los absorbe el agente (degrada); esto cubre caídas de la base o de Redis.
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });

  constructor() {
    this.queue.on('error', (err) => console.error(`[agent] error de la cola: ${err.message}`));
  }

  add(job: AgentJob) { return this.queue.add(job.kind, job, { jobId: `agent-${job.inboundId}-${job.kind}` }); }

  async onModuleDestroy() { await this.queue.close(); }
}
