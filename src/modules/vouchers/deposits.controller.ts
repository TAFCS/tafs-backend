import { Controller, Delete, HttpCode, HttpStatus, Param, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('deposits')
export class DepositsController {
    constructor(private readonly vouchersService: VouchersService) {}

    @Delete(':id')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Delete, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async reverseDeposit(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const result = await this.vouchersService.reverseDeposit(id, changedBy);
        return {
            success: true,
            message: 'Deposit reversed and deleted successfully',
            data: result,
        };
    }
}
