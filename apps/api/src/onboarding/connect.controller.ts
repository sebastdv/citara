import {
  BadGatewayException, BadRequestException, Body, Controller, Get, GoneException, HttpCode, HttpStatus,
  Logger, Post, Query, Res, UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { OnboardingService, LinkInvalidError, OnboardingInputError } from './onboarding.service';
import { MetaOnboardingError } from './meta-onboarding.client';
import { peekLink } from './links';
import { connectPage, invalidLinkPage } from './connect-page';

const FINISH_EVENTS = new Set(['FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', 'FINISH']);
const completeSchema = z.object({
  t: z.string().min(16),
  code: z.string().min(1),
  waba_id: z.string().regex(/^\d+$/),
  phone_number_id: z.string().regex(/^\d+$/).nullish(),
  event: z.string().nullish(),
});

@Controller('connect/whatsapp')
export class ConnectController {
  private readonly log = new Logger(ConnectController.name);

  constructor(private readonly ds: DataSource, private readonly onboarding: OnboardingService) {}

  @Get()
  async page(@Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    // El token va en la URL: ni caché ni Referer hacia el CDN de Meta.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const link = token ? await peekLink(this.ds, token, 'whatsapp') : null;
    if (!token || !link) {
      res.status(HttpStatus.GONE).type('html').send(invalidLinkPage());
      return;
    }
    res.status(HttpStatus.OK).type('html').send(connectPage({
      token, tenantName: link.tenantName,
      appId: process.env.META_APP_ID ?? '', configId: process.env.META_ES_CONFIG_ID ?? '',
      graphVersion: process.env.META_GRAPH_VERSION ?? 'v25.0',
    }));
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Body() raw: unknown) {
    const parsed = completeSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Faltan datos para completar la conexión');
    const b = parsed.data;
    if (b.event && !FINISH_EVENTS.has(b.event)) {
      throw new UnprocessableEntityException('La conexión no se completó en Meta');
    }
    try {
      const r = await this.onboarding.completeWhatsapp(
        { token: b.t, code: b.code, wabaId: b.waba_id, phoneNumberId: b.phone_number_id ?? null });
      return { ok: true, numero: r.displayPhoneNumber };
    } catch (err) {
      if (err instanceof LinkInvalidError) throw new GoneException(err.message);
      if (err instanceof OnboardingInputError) throw new UnprocessableEntityException(err.message);
      if (err instanceof MetaOnboardingError) {
        this.log.warn(`alta incompleta: ${err.message}`);
        throw new BadGatewayException('Meta no completó la conexión. Intenta de nuevo en unos minutos.');
      }
      throw err;
    }
  }
}
