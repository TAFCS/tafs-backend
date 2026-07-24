import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import { ApplyHouseBalanceDto } from './dto/apply-house-balance.dto';
import {
  ApplyCampusHouseBalanceDto,
  CampusHouseBalancePreviewDto,
} from './dto/campus-house-balance.dto';
import { HouseBalancerHistoryQueryDto } from './dto/house-balancer-history.dto';
import { HouseBalancerScopeDto } from './dto/house-balancer-scope.dto';
import { HouseBalancerService } from './house-balancer.service';

@Controller('house-balancer')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class HouseBalancerController {
  constructor(private readonly houseBalancerService: HouseBalancerService) {}

  @Get('history')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async listHistory(@Query() query: HouseBalancerHistoryQueryDto) {
    const data = await this.houseBalancerService.listHistory(
      query.campus_id,
      query.limit,
      query.offset,
    );
    return createApiResponse(data, HttpStatus.OK, 'House rebalance history');
  }

  @Get('history/:id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async getHistory(@Param('id', ParseIntPipe) id: number) {
    const data = await this.houseBalancerService.getHistory(id);
    return createApiResponse(data, HttpStatus.OK, 'House rebalance history detail');
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async preview(@Body() dto: HouseBalancerScopeDto) {
    const data = await this.houseBalancerService.preview(dto);
    return createApiResponse(data, HttpStatus.OK, 'House balance preview generated');
  }

  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async apply(@Body() dto: ApplyHouseBalanceDto, @Req() req: Request) {
    const changedBy =
      (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.houseBalancerService.apply(dto, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'House assignments applied');
  }

  @Post('preview-campus')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async previewCampus(@Body() dto: CampusHouseBalancePreviewDto) {
    const data = await this.houseBalancerService.previewCampus(dto);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Campus-wide house balance preview generated',
    );
  }

  @Post('apply-campus')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async applyCampus(
    @Body() dto: ApplyCampusHouseBalanceDto,
    @Req() req: Request,
  ) {
    const changedBy =
      (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.houseBalancerService.applyCampus(dto, changedBy);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Campus-wide house assignments applied',
    );
  }
}
