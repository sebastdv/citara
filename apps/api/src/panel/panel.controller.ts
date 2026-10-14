import { Controller, Get, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { LoginRedirectFilter, PanelGuard, pageCtx, sessionCookie, type PanelRequest } from './panel-auth';
import { destroySession } from './sessions';
import { panelPage, sendHtml } from './layout';
import { html } from './html';

@Controller('panel')
@UseGuards(PanelGuard)
@UseFilters(LoginRedirectFilter)
export class PanelController {
  constructor(private readonly ds: DataSource) {}

  @Get()
  async inbox(@Req() req: PanelRequest, @Res() res: Response) {
    const ctx = pageCtx(req);
    sendHtml(res, 200, panelPage('Bandeja', ctx, html`<h1>Bandeja</h1><div id="lista"></div>`), ctx.nonce);
  }

  @Post('logout')
  async logout(@Req() req: PanelRequest, @Res() res: Response) {
    await destroySession(this.ds, req.sessionToken!);
    res.clearCookie(sessionCookie.name, { path: '/panel' });
    res.redirect(303, '/panel/login');
  }
}

/** Los controladores del panel tras el guard (el test de barrido los recorre). */
export const PANEL_CONTROLLERS = [PanelController];
