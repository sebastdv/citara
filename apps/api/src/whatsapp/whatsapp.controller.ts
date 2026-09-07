import {
  Controller, Get, Post, Query, Req, Res, HttpCode, HttpStatus, ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { verifyMetaSignature } from './signature';
import { IngestService } from './ingest.service';

@Controller('webhooks/whatsapp')
export class WhatsappController {
  constructor(private readonly ingest: IngestService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    if (mode !== 'subscribe' || token !== process.env.META_VERIFY_TOKEN) {
      throw new ForbiddenException();
    }
    res.status(HttpStatus.OK).send(challenge);
  }

  @Post()
  // Nest devuelve 201 por defecto en un @Post(). Meta espera 200: un código
  // distinto se interpreta como fallo y dispara reintentos.
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    const ok = verifyMetaSignature(
      req.rawBody ?? Buffer.alloc(0),
      req.header('x-hub-signature-256'),
      process.env.META_APP_SECRET!,
    );
    if (!ok) throw new UnauthorizedException('firma inválida');

    // Todo lo pesado va a la cola. Aquí solo se persiste y se encola.
    return this.ingest.ingest(req.body);
  }
}
