import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FeesService } from './fees.service';
import { SubmitStudentFeesDto } from './dto/submit-student-fees.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('fees')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class FeesController {
  constructor(private readonly feesService: FeesService) {}

  // POST /api/v1/fees/student
  @Post('student')
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
}
