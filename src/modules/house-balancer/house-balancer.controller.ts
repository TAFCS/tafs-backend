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
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAnyAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
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

// The page is listed under two tiles (student.house_balancer and
// school-setup.house_balancer), so every route accepts either tile's action.
// The policy check stays as it was; the tile action is ANDed with it.
@Controller('house-balancer')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
@RequireAnyAction('student.house_balancer#view', 'school-setup.house_balancer#view')
export class HouseBalancerController {
  constructor(private readonly houseBalancerService: HouseBalancerService) {}

  @Get('history')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async listHistory(@Query() query: HouseBalancerHistoryQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.houseBalancerService.listHistory(
      query.campus_id,
      query.limit,
      query.offset,
      user,
    );
    return createApiResponse(data, HttpStatus.OK, 'House rebalance history');
  }

  @Get('history/:id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async getHistory(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.houseBalancerService.getHistory(id, user);
    return createApiResponse(data, HttpStatus.OK, 'House rebalance history detail');
  }

  @Post('preview')
  @RequireAnyAction('student.house_balancer#preview', 'school-setup.house_balancer#preview')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async preview(@Body() dto: HouseBalancerScopeDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.houseBalancerService.preview(dto, user);
    return createApiResponse(data, HttpStatus.OK, 'House balance preview generated');
  }

  @Post('apply')
  @RequireAnyAction('student.house_balancer#apply', 'school-setup.house_balancer#apply')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async apply(@Body() dto: ApplyHouseBalanceDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy =
      (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.houseBalancerService.apply(dto, changedBy, user);
    return createApiResponse(data, HttpStatus.OK, 'House assignments applied');
  }

  @Post('preview-campus')
  @RequireAnyAction('student.house_balancer#preview', 'school-setup.house_balancer#preview')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async previewCampus(@Body() dto: CampusHouseBalancePreviewDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.houseBalancerService.previewCampus(dto, user);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Campus-wide house balance preview generated',
    );
  }

  @Post('apply-campus')
  @RequireAnyAction('student.house_balancer#apply', 'school-setup.house_balancer#apply')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
  async applyCampus(
    @Body() dto: ApplyCampusHouseBalanceDto,
    @Req() req: Request,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy =
      (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.houseBalancerService.applyCampus(dto, changedBy, user);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Campus-wide house assignments applied',
    );
  }
}
