import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FeesService } from './fees.service';
import { SubmitStudentFeesDto } from './dto/submit-student-fees.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('fees')
export class FeesController {
  constructor(private readonly feesService: FeesService) {}

  // POST /api/v1/fees/student
  @Post('student')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Fee'))
  async submitStudentFees(@Body() dto: SubmitStudentFeesDto) {
    const result = await this.feesService.submitStudentFees(dto);
    return {
      success: true,
      message: `${result.upserted} fee record(s) saved successfully`,
      data: result,
    };
  }

  @Get('parent/student/:cc/summary')
  @UseGuards(JwtParentGuard)
  @HttpCode(HttpStatus.OK)
  async getFeeSummary(@Param('cc', ParseIntPipe) cc: number, @Req() req: any) {
    const familyId = req.user.familyId;
    const summary = await this.feesService.getFeeSummaryForParent(cc, familyId);
    return {
      success: true,
      message: 'Fee summary retrieved successfully',
      data: summary,
    };
  }
}
