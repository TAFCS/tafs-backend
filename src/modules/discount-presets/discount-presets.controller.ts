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
import { DiscountPresetsService } from './discount-presets.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateDiscountPresetDto, UpdateDiscountPresetDto } from './dto/discount-presets.dto';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('discount-presets')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class DiscountPresetsController {
    constructor(private readonly discountPresetsService: DiscountPresetsService) {}

    @Get()
    @CheckPolicies((ability) => ability.can(Action.Read, 'Fee') || ability.can(Action.Manage, 'all'))
    async findAll(@Query('active') active?: string) {
        const onlyActive = active === 'true';
        const data = await this.discountPresetsService.findAll(onlyActive);
        return { success: true, data };
    }

    @Get(':id')
    @CheckPolicies((ability) => ability.can(Action.Read, 'Fee') || ability.can(Action.Manage, 'all'))
    async findOne(@Param('id', ParseIntPipe) id: number) {
        const data = await this.discountPresetsService.findOne(id);
        return { success: true, data };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies((ability) => ability.can(Action.Create, 'Fee') || ability.can(Action.Manage, 'all'))
    async create(@Body() dto: CreateDiscountPresetDto, @CurrentUser() user: IJwtStaffPayload) {
        const data = await this.discountPresetsService.create(dto, user.username);
        return { success: true, data };
    }

    @Patch(':id')
    @CheckPolicies((ability) => ability.can(Action.Update, 'Fee') || ability.can(Action.Manage, 'all'))
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateDiscountPresetDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.discountPresetsService.update(id, dto, user.username);
        return { success: true, data };
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Fee') || ability.can(Action.Manage, 'all'))
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        await this.discountPresetsService.remove(id, user.username);
        return { success: true, message: 'Discount preset deactivated' };
    }
}
