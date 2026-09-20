import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Patch,
    Post,
    Put,
    Param,
    Delete,
    UseGuards,
    ParseIntPipe,
    Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CampusesService } from './campuses.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction, RequireAnyAction } from '../../decorators/require-action.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { Action } from '../auth/casl/actions';
import { CreateCampusDto } from './dto/create-campus.dto';
import { BulkUpdateCampusesDto } from './dto/bulk-update-campuses.dto';
import { UpsertCampusSectionDto } from './dto/upsert-campus-section.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { CAMPUSES_MESSAGES } from '../../constants/api-response/campuses.constant';

// GET routes are read by nearly every page for campus dropdowns, so they stay
// undecorated at the tile layer. The section-mapping PUT is shared by the
// Campuses page, Student Overrides and Section Allocation Rules, so it takes
// @RequireAnyAction across those tiles. Routes exclusive to the Campuses page
// carry @RequireAction. Scope is enforced on every write.
@Controller('campuses')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class CampusesController {
    constructor(private readonly campusesService: CampusesService) { }

    @Get()
    @CheckPolicies((ability) => ability.can(Action.Read, 'Campus'))
    async findAll() {
        const campuses = await this.campusesService.findAll();
        return createApiResponse(
            campuses,
            HttpStatus.OK,
            CAMPUSES_MESSAGES.LIST_SUCCESS,
        );
    }

    @Get(':id')
    @CheckPolicies((ability) => ability.can(Action.Read, 'Campus'))
    async findOne(@Param('id', ParseIntPipe) id: number) {
        const campus = await this.campusesService.findOne(id);
        return createApiResponse(
            campus,
            HttpStatus.OK,
            CAMPUSES_MESSAGES.DETAIL_SUCCESS,
        );
    }

    @Get(':id/dependencies')
    @CheckPolicies((ability) => ability.can(Action.Read, 'Campus'))
    async getDependencies(@Param('id', ParseIntPipe) id: number) {
        return this.campusesService.getDependencies(id);
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies((ability) => ability.can(Action.Create, 'Campus'))
    @RequireAction('school-setup.campuses#create')
    async create(@Body() dto: CreateCampusDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const campus = await this.campusesService.create(dto, changedBy, user);
        return createApiResponse(
            campus,
            HttpStatus.CREATED,
            CAMPUSES_MESSAGES.CREATE_SUCCESS,
        );
    }

    @Patch('bulk')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
    @RequireAction('school-setup.campuses#edit')
    async bulkUpdate(@Body() dto: BulkUpdateCampusesDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const updated = await this.campusesService.bulkUpdate(dto, changedBy, user);
        return createApiResponse(
            updated,
            HttpStatus.OK,
            CAMPUSES_MESSAGES.BULK_UPDATE_SUCCESS,
        );
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Campus'))
    @RequireAction('school-setup.campuses#delete')
    async delete(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        await this.campusesService.delete(id, changedBy, user);
        return createApiResponse(null, HttpStatus.OK, CAMPUSES_MESSAGES.DELETE_SUCCESS);
    }

    // ─── Campus Classes ───────────────────────────────────────────────────────

    @Put(':id/classes/:classId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
    @RequireAction('school-setup.campuses#classes.manage')
    async upsertCampusClass(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @CurrentUser() user: IJwtStaffPayload,
        @Body('is_active') isActive?: boolean,
        @Req() req?: Request,
    ) {
        const changedBy = (req?.user as any)?.username || (req?.user as any)?.id || 'system';
        const campus = await this.campusesService.upsertCampusClass(id, classId, isActive, changedBy, user);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.CLASS_UPDATED);
    }

    @Delete(':id/classes/:classId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Campus'))
    @RequireAction('school-setup.campuses#classes.manage')
    async removeClassFromCampus(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @Req() req: Request,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const campus = await this.campusesService.removeClassFromCampus(id, classId, changedBy, user);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.CLASS_REMOVED);
    }

    // ─── Campus Sections ──────────────────────────────────────────────────────

    // Called by four pages across three tiles: the Campuses page, Student
    // Overrides (which syncs the section on save) and Section Allocation Rules
    // (listed under two tile ids). Each tile's own action is accepted; scope is
    // still enforced on every write.
    @Put(':id/classes/:classId/sections/:sectionId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
    @RequireAnyAction(
        'school-setup.campuses#classes.manage',
        'finance.student_overrides#schedule.edit',
        'student.section_allocation#rules.edit',
        'school-setup.section_allocation#rules.edit',
    )
    async upsertCampusSection(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @Param('sectionId', ParseIntPipe) sectionId: number,
        @Body() dto: UpsertCampusSectionDto,
        @Req() req: Request,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const campus = await this.campusesService.upsertCampusSection(id, classId, sectionId, dto, changedBy, user);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.SECTION_UPDATED);
    }

    @Delete(':id/classes/:classId/sections/:sectionId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Campus'))
    @RequireAction('school-setup.campuses#classes.manage')
    async removeSectionFromCampus(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @Param('sectionId', ParseIntPipe) sectionId: number,
        @Req() req: Request,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const campus = await this.campusesService.removeSectionFromCampus(id, classId, sectionId, changedBy, user);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.SECTION_REMOVED);
    }
}
