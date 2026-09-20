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
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../../modules/auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

// Registration's routes. The policy check on each is unchanged and ANDed with
// the tile action; every cc-addressed route and the placement being registered
// into are limited to the caller's scope. The guardian-by-CNIC lookup is not
// scoped: a guardian is not tied to a campus, and registration needs to find
// an existing guardian to link siblings across campuses.
@Controller('admissions')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class IdentityController {
  constructor(private readonly identityService: IdentityService) { }

  @Post('register')
  @RequireAction('student.registration#register')
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Student'))
  async register(@Body() dto: any, @CurrentUser() user: IJwtStaffPayload) {
    console.log('[DEBUG] Register Admission DTO:', JSON.stringify(dto, null, 2));
    const student = await this.identityService.registerAdmission(dto, user.username, user);
    return {
      success: true,
      message: 'Admission registered successfully',
      data: student,
    };
  }

  @Post('admission-form')
  @RequireAction('student.registration#admission_form')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async submitAdmissionForm(@Body() dto: SubmitAdmissionFormDto, @CurrentUser() user: IJwtStaffPayload) {
    const student = await this.identityService.submitAdmissionForm(dto, user);
    return {
      success: true,
      message: 'Comprehensive admission form submitted successfully',
      data: student,
    };
  }

  @Get('by-cc/:cc')
  @RequireAction('student.registration#view')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getByCC(@Param() params: GetByCcParamsDto, @CurrentUser() user: IJwtStaffPayload) {
    const student = await this.identityService.getAdmissionByCC(params.cc, user);
    return {
      success: true,
      message: 'Admission fetched successfully',
      data: student,
    };
  }

  @Get('guardians/by-cnic/:cnic')
  @RequireAction('student.registration#view')
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
