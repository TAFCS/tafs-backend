import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { CreateAdmissionDto } from './dto/create-admission.dto';
import { GetByCcParamsDto } from './dto/get-by-cc-params.dto';
import { SubmitAdmissionFormDto } from './dto/submit-admission-form.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../../modules/auth/casl/actions';

@Controller('admissions')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class IdentityController {
  constructor(private readonly identityService: IdentityService) { }

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

  @Post('admission-form')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async submitAdmissionForm(@Body() dto: SubmitAdmissionFormDto) {
    const student = await this.identityService.submitAdmissionForm(dto);
    return {
      success: true,
      message: 'Comprehensive admission form submitted successfully',
      data: student,
    };
  }

  @Get('by-cc/:cc')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getByCC(@Param() params: GetByCcParamsDto) {
    const student = await this.identityService.getAdmissionByCC(params.cc);
    return {
      success: true,
      message: 'Admission fetched successfully',
      data: student,
    };
  }

  @Get('guardians/by-cnic/:cnic')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getGuardianByCnic(@Param('cnic') cnic: string) {
    const guardian = await this.identityService.getGuardianByCnic(cnic);
    return {
      success: true,
      message: 'Guardian fetched successfully',
      data: guardian,
    };
  }
}
