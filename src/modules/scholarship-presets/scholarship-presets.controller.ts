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
import { ScholarshipPresetsService } from './scholarship-presets.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateScholarshipPresetDto, UpdateScholarshipPresetDto } from './dto/scholarship-presets.dto';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('scholarship-presets')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ScholarshipPresetsController {
    constructor(private readonly scholarshipPresetsService: ScholarshipPresetsService) {}

    @Get()
    @CheckPolicies((ability) => ability.can(Action.Read, 'Fee') || ability.can(Action.Manage, 'all'))
    async findAll(@Query('active') active?: string) {
        const onlyActive = active === 'true';
        const data = await this.scholarshipPresetsService.findAll(onlyActive);
        return { success: true, data };
    }

    @Get(':id')
    @CheckPolicies((ability) => ability.can(Action.Read, 'Fee') || ability.can(Action.Manage, 'all'))
    async findOne(@Param('id', ParseIntPipe) id: number) {
        const data = await this.scholarshipPresetsService.findOne(id);
        return { success: true, data };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies((ability) => ability.can(Action.Create, 'Fee') || ability.can(Action.Manage, 'all'))
    async create(@Body() dto: CreateScholarshipPresetDto, @CurrentUser() user: IJwtStaffPayload) {
        const data = await this.scholarshipPresetsService.create(dto, user.username);
        return { success: true, data };
    }

    @Patch(':id')
    @CheckPolicies((ability) => ability.can(Action.Update, 'Fee') || ability.can(Action.Manage, 'all'))
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateScholarshipPresetDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.scholarshipPresetsService.update(id, dto, user.username);
        return { success: true, data };
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Fee') || ability.can(Action.Manage, 'all'))
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        await this.scholarshipPresetsService.remove(id, user.username);
        return { success: true, message: 'Scholarship preset deactivated' };
    }
}
