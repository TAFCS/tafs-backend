import { Controller, Get, UseGuards } from '@nestjs/common';
import { ClassesService } from './classes.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('classes')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Class'))
  async findAll() {
    const classes = await this.classesService.findAll();
    return {
      success: true,
      message: 'Classes list retrieved successfully',
      data: classes,
    };
  }
}
