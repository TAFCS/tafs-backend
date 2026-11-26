import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import { GuideCombineDto } from './dto/guide.dto';
import { GuideService } from './guide.service';

/**
 * TAFSD-616: the Guide tile (system.user_guide). Every route needs the tile's
 * `view` action; a new route needs its own action (see the tile's MAINTENANCE note).
 */
@ApiTags('Guide')
@Controller('guide')
@UseGuards(JwtStaffGuard, TileActionGuard)
@RequireAction('system.user_guide#view')
export class GuideController {
  constructor(private readonly guide: GuideService) {}

  @Get()
  @ApiOperation({ summary: 'The published manual: areas and modules in reading order, with their PDFs' })
  async contents() {
    return createApiResponse(await this.guide.contents(), HttpStatus.OK, 'Guide fetched');
  }

  @Get('files/:file')
  @ApiOperation({ summary: 'One PDF of the published manual (the whole manual, an area or a module)' })
  async file(@Param('file') file: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const bytes = await this.guide.file(file);
    this.sendPdf(res, bytes, file, inline === '1' || inline === 'true');
  }

  @Post('combine')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Several modules joined into one PDF, in reading order, with a cover and contents' })
  async combine(@Body() dto: GuideCombineDto, @Res() res: Response) {
    const { bytes, pages } = await this.guide.combine(dto.modules);
    const name = `TAFSync-Guide-selected-${new Date().toISOString().slice(0, 10)}.pdf`;
    res.set('X-Guide-Pages', String(pages));
    this.sendPdf(res, Buffer.from(bytes), name, false);
  }

  private sendPdf(res: Response, bytes: Buffer, name: string, inline: boolean) {
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]/g, '_')}"`,
      'Content-Length': bytes.length,
      'Cache-Control': 'private, max-age=300',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Guide-Pages',
    });
    res.end(bytes);
  }
}
