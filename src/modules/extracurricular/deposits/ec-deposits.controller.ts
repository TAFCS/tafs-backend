import { Body, Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { RecordEcDepositDto, ReverseEcDepositDto } from './dto/ec-deposits.dto';
import { EcDepositsService } from './ec-deposits.service';

/**
 * TAFSD-605: Extracurricular Fees → Receive Deposit (record) and Payment History
 * (reverse). Every route has its own action; a new route needs one too (see the
 * MAINTENANCE note in tiles.manifest.ts).
 */
@ApiTags('Extracurricular Fees')
@Controller('ec-deposits')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class EcDepositsController {
    constructor(private readonly service: EcDepositsService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Record a full or partial payment against one extracurricular voucher' })
    @RequireAction('extracurricular.receive_deposit#record')
    async record(@Body() dto: RecordEcDepositDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.record(user, dto), HttpStatus.CREATED, 'Payment recorded');
    }

    @Post(':id/reverse')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Reverse the latest payment on a voucher, with a reason' })
    @RequireAction('extracurricular.payment_history#reverse')
    async reverse(@Param('id', ParseIntPipe) id: number, @Body() dto: ReverseEcDepositDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.reverse(user, id, dto), HttpStatus.OK, 'Payment reversed');
    }
}
