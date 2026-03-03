import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { CreateAdmissionDto } from './dto/create-admission.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../../modules/auth/casl/actions';

@Controller('admissions')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Student'))
  async register(@Body() dto: CreateAdmissionDto) {
    const student = await this.identityService.registerAdmission(dto);
    return {
      success: true,
      message: 'Admission registered successfully',
      data: student,
    };
  }
}
