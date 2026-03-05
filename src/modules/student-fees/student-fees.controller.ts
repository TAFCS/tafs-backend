import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { StudentFeesService } from './student-fees.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { BulkSaveStudentFeesDto } from './dto/bulk-save-student-fees.dto';

@Controller('student-fees')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StudentFeesController {
    constructor(private readonly studentFeesService: StudentFeesService) { }

    @Get('by-student/:ccNumber')
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'StudentFee') ||
            ability.can(Action.Manage, 'all'),
    )
    async findByStudentCC(@Param('ccNumber') ccNumber: string) {
        const fees = await this.studentFeesService.findByStudentCC(ccNumber);
        return {
            success: true,
            message: 'Student fees retrieved successfully',
            data: fees,
        };
    }

    @Post('bulk')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'StudentFee') ||
            ability.can(Action.Update, 'StudentFee') ||
            ability.can(Action.Manage, 'all'),
    )
    async bulkSave(@Body() dto: BulkSaveStudentFeesDto) {
        const updated = await this.studentFeesService.bulkSave(dto);
        return {
            success: true,
            message: 'Student fees saved successfully',
            data: updated,
        };
    }
}
