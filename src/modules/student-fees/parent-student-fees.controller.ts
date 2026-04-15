import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Req,
    UseGuards,
} from '@nestjs/common';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { StudentFeesService } from './student-fees.service';

@Controller('student-fees/parent')
@UseGuards(JwtParentGuard)
export class ParentStudentFeesController {
    constructor(private readonly studentFeesService: StudentFeesService) {}

    @Get('student/:cc/monthly-status')
    @HttpCode(HttpStatus.OK)
    async getMonthlyStatusForParent(
        @Param('cc', ParseIntPipe) cc: number,
        @Req() req: any,
    ) {
        const familyId = req.user.familyId;
        const months = await this.studentFeesService.getMonthlyStatusForParent(
            cc,
            familyId,
        );

        return {
            success: true,
            message: 'Month-wise fee status retrieved successfully',
            data: months,
        };
    }
}
