import { Controller, Get, HttpStatus, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import { API_DOCS_VIEW_ACTION } from './api-docs.constants';
import { ApiDocsService } from './api-docs.service';

/**
 * TAFSD-614: API Docs tile. Read-only; every route needs the tile's `view`,
 * which like every web tile is granted per person in People & Access.
 */
@Controller('api-docs')
@UseGuards(JwtStaffGuard, TileActionGuard)
@RequireAction(API_DOCS_VIEW_ACTION)
export class ApiDocsController {
  constructor(private readonly docs: ApiDocsService) {}

  @Get()
  list() {
    return createApiResponse(this.docs.list(), HttpStatus.OK, 'API documents retrieved');
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return createApiResponse(this.docs.get(slug), HttpStatus.OK, 'API document retrieved');
  }

  @Get(':slug/pdf')
  pdf(@Param('slug') slug: string, @Res() res: Response) {
    const { path, filename } = this.docs.pdfPath(slug);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path);
  }
}
