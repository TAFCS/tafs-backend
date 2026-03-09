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
} from '@nestjs/common';
import { CampusesService } from './campuses.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateCampusDto } from './dto/create-campus.dto';
import { BulkUpdateCampusesDto } from './dto/bulk-update-campuses.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { CAMPUSES_MESSAGES } from '../../constants/api-response/campuses.constant';

@Controller('campuses')
@UseGuards(JwtStaffGuard, PoliciesGuard)
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

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies((ability) => ability.can(Action.Create, 'Campus'))
    async create(@Body() dto: CreateCampusDto) {
        const campus = await this.campusesService.create(dto);
        return createApiResponse(
            campus,
            HttpStatus.CREATED,
            CAMPUSES_MESSAGES.CREATE_SUCCESS,
        );
    }

    @Patch('bulk')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
    async bulkUpdate(@Body() dto: BulkUpdateCampusesDto) {
        const updated = await this.campusesService.bulkUpdate(dto);
        return createApiResponse(
            updated,
            HttpStatus.OK,
            CAMPUSES_MESSAGES.BULK_UPDATE_SUCCESS,
        );
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Campus'))
    async delete(@Param('id', ParseIntPipe) id: number) {
        await this.campusesService.delete(id);
        return createApiResponse(null, HttpStatus.OK, CAMPUSES_MESSAGES.DELETE_SUCCESS);
    }

    // ─── Campus Classes ───────────────────────────────────────────────────────

    @Put(':id/classes/:classId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
    async upsertCampusClass(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @Body('is_active') isActive?: boolean,
    ) {
        const campus = await this.campusesService.upsertCampusClass(id, classId, isActive);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.CLASS_UPDATED);
    }

    @Delete(':id/classes/:classId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Campus'))
    async removeClassFromCampus(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
    ) {
        const campus = await this.campusesService.removeClassFromCampus(id, classId);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.CLASS_REMOVED);
    }

    // ─── Campus Sections ──────────────────────────────────────────────────────

    @Put(':id/classes/:classId/sections/:sectionId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'Campus'))
    async upsertCampusSection(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @Param('sectionId', ParseIntPipe) sectionId: number,
        @Body('is_active') isActive?: boolean,
    ) {
        const campus = await this.campusesService.upsertCampusSection(id, classId, sectionId, isActive);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.SECTION_UPDATED);
    }

    @Delete(':id/classes/:classId/sections/:sectionId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Campus'))
    async removeSectionFromCampus(
        @Param('id', ParseIntPipe) id: number,
        @Param('classId', ParseIntPipe) classId: number,
        @Param('sectionId', ParseIntPipe) sectionId: number,
    ) {
        const campus = await this.campusesService.removeSectionFromCampus(id, classId, sectionId);
        return createApiResponse(campus, HttpStatus.OK, CAMPUSES_MESSAGES.SECTION_REMOVED);
    }
}
