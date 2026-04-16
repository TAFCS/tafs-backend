import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FamiliesService } from './families.service';
import { QueryFamiliesDto } from './dto/query-families.dto';
import { CreateFamilyDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';
import { AssignStudentDto } from './dto/assign-student.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('families')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class FamiliesController {
  constructor(private readonly familiesService: FamiliesService) {}

  // GET /api/v1/families?page=1&limit=10&search=smith
  @Get()
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Family'))
  async listFamilies(@Query() query: QueryFamiliesDto) {
    const result = await this.familiesService.listFamilies(query);
    return {
      success: true,
      message: 'Families fetched successfully',
      data: result.families,
      meta: result.meta,
    };
  }

  // GET /api/v1/families/:id
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Family'))
  async getFamilyById(@Param('id', ParseIntPipe) id: number) {
    const family = await this.familiesService.getFamilyById(id);
    return {
      success: true,
      message: 'Family fetched successfully',
      data: family,
    };
  }

  // POST /api/v1/families
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Family'))
  async createFamily(@Body() dto: CreateFamilyDto) {
    const family = await this.familiesService.createFamily(dto);
    return {
      success: true,
      message: 'Family created successfully',
      data: family,
    };
  }

  // PATCH /api/v1/families/:id
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Family'))
  async updateFamily(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFamilyDto,
  ) {
    const family = await this.familiesService.updateFamily(id, dto);
    return {
      success: true,
      message: 'Family updated successfully',
      data: family,
    };
  }

  // POST /api/v1/families/:id/assign-child
  @Post(':id/assign-child')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Family'))
  async assignChild(
    @Param('id', ParseIntPipe) familyId: number,
    @Body() dto: AssignStudentDto,
  ) {
    // eslint-disable-next-line no-console
    console.log(`[FamiliesController] familyId: ${familyId}, Raw Body: ${JSON.stringify(dto)}`);
    const student = await this.familiesService.assignChildToFamily(
      familyId,
      dto.student_id,
    );
    return {
      success: true,
      message: `Student #${dto.student_id} assigned to family #${familyId}`,
      data: student,
    };
  }

  // DELETE /api/v1/families/:id/students/:studentId
  @Delete(':id/students/:studentId')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Family'))
  async removeChild(
    @Param('id', ParseIntPipe) familyId: number,
    @Param('studentId', ParseIntPipe) studentId: number,
  ) {
    await this.familiesService.removeChildFromFamily(familyId, studentId);
    return {
      success: true,
      message: `Student #${studentId} removed from family #${familyId}`,
    };
  }
}
