import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { UNIFORM_PHOTO_ACTION_KEY } from './uniform-photo.constants';
import { UniformPhotosService } from './uniform-photos.service';

class SetUniformPhotoPendingDto {
  @IsBoolean()
  pending!: boolean;
}

/**
 * TAFSD-527. The list itself is the Student Directory with
 * `uniform_photo=pending`, so it is gated like the directory; these routes are
 * the count for the banner and the manual override.
 */
@Controller('uniform-photos')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class UniformPhotosController {
  constructor(private readonly service: UniformPhotosService) {}

  @Get('summary')
  @RequireAction('student.directory#view')
  async summary(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(await this.service.summary(user), HttpStatus.OK, 'Uniform photo summary retrieved');
  }

  @Patch(':cc')
  @RequireAction(UNIFORM_PHOTO_ACTION_KEY)
  async setPending(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() dto: SetUniformPhotoPendingDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(await this.service.setPending(cc, dto.pending, user), HttpStatus.OK, 'Uniform photo flag updated');
  }
}
