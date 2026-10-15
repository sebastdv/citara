import { Controller, Get, HttpStatus, Res, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
// Import de VALOR: parámetro del constructor de un controlador Nest.
import { HealthChecker } from './health';

@Controller('healthz')
export class HealthController implements OnModuleDestroy {
  constructor(private readonly health: HealthChecker) {}

  onModuleDestroy() { return this.health.close(); }

  @Get()
  async check(@Res() res: Response) {
    const r = await this.health.check();
    const ok = r.postgres && r.redis;
    res.setHeader('Cache-Control', 'no-store');
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({ status: ok ? 'ok' : 'error', ...r });
  }
}
