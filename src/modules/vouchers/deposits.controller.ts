import { Controller, Delete, HttpCode, HttpStatus, Param, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAnyTile } from '../../decorators/require-action.decorator';
import { Action } from '../auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('deposits')
export class DepositsController {
    constructor(private readonly vouchersService: VouchersService) {}

    @Delete(':id')
    @RequireAnyTile('finance.payment_history', 'finance.vouchers')
    @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Delete, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async reverseDeposit(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: any,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const result = await this.vouchersService.reverseDeposit(id, changedBy, user);
        return {
            success: true,
            message: 'Deposit reversed and deleted successfully',
            data: result,
        };
    }
}
