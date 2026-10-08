import { Controller, Get, HttpStatus, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { GoogleClient, GoogleApiError } from './google.client';
import { GoogleConnectService } from './google-connect.service';
import { connectGooglePage, resultPage } from './connect-google-page';
import { invalidLinkPage } from '../onboarding/connect-page';
import { peekLink } from '../onboarding/links';
import { LinkInvalidError, OnboardingInputError } from '../onboarding/onboarding.service';

@Controller('connect/google')
export class ConnectGoogleController {
  private readonly log = new Logger(ConnectGoogleController.name);

  constructor(
    private readonly ds: DataSource,
    private readonly google: GoogleClient,
    private readonly connect: GoogleConnectService,
  ) {}

  @Get()
  async page(@Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    secure(res);
    const link = token ? await peekLink(this.ds, token, 'google') : null;
    if (!token || !link?.resourceName) {
      res.status(HttpStatus.GONE).type('html').send(invalidLinkPage());
      return;
    }
    // El token viaja como `state` y vuelve en el callback: así se sabe qué enlace se completa.
    res.status(HttpStatus.OK).type('html').send(connectGooglePage({
      tenantName: link.tenantName, resourceName: link.resourceName, authUrl: this.google.authUrl(token) }));
  }

  @Get('callback')
  async callback(
    @Query('state') state: string | undefined, @Query('code') code: string | undefined,
    @Query('error') error: string | undefined, @Res() res: Response,
  ): Promise<void> {
    secure(res);
    const send = (status: number, html: string) => { res.status(status).type('html').send(html); };
    if (error) {
      send(HttpStatus.OK, resultPage('Conexión cancelada',
        'No se conectó el calendario. Si fue un error, vuelve a abrir el enlace que te enviaron.'));
      return;
    }
    if (!state || !code) {
      send(HttpStatus.BAD_REQUEST, resultPage('Faltan datos', 'Vuelve a abrir el enlace que te enviaron.'));
      return;
    }
    try {
      const r = await this.connect.complete({ token: state, code });
      send(HttpStatus.OK, resultPage('¡Listo!',
        `El calendario de ${r.resourceName} quedó conectado. Tus citas aparecerán en «Citas · ${r.resourceName}». ` +
        'Ya puedes cerrar esta página.'));
    } catch (err) {
      if (err instanceof LinkInvalidError) { send(HttpStatus.GONE, invalidLinkPage()); return; }
      if (err instanceof OnboardingInputError) {
        send(HttpStatus.UNPROCESSABLE_ENTITY, resultPage('Falta un paso', err.message));
        return;
      }
      if (err instanceof GoogleApiError) {
        this.log.warn(`conexión de Google incompleta: ${err.message}`);
        send(HttpStatus.BAD_GATEWAY, resultPage('No se pudo conectar',
          'Google no completó la conexión. Intenta de nuevo en unos minutos.'));
        return;
      }
      throw err;
    }
  }
}

/** El token del enlace (y el code de Google) van en la URL: ni caché, ni Referer, ni marcos. */
function secure(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}
