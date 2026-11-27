import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import {
    EcBulkAssignDto,
    EcBulkRemoveDto,
    EcClassAmountsQueryDto,
    EcStudentChargesQueryDto,
    SaveEcStudentChargesDto,
} from './dto/ec-charges.dto';
import { EcChargesService } from './ec-charges.service';

/**
 * TAFSD-605: Extracurricular Fees → Student Charges (tile
 * extracurricular.student_charges). Every route has its own action; a new
 * route needs one too (see the tile's MAINTENANCE note in tiles.manifest.ts).
 */
@ApiTags('Extracurricular Fees')
@Controller('ec-student-charges')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class EcChargesController {
    constructor(private readonly service: EcChargesService) {}

    @Post('bulk-assign/preview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'What a bulk assign would charge, without saving anything' })
    @RequireAction('extracurricular.student_charges#bulk_assign')
    async bulkAssignPreview(@Body() dto: EcBulkAssignDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.bulkAssignPreview(user, dto), HttpStatus.OK, 'Bulk assign preview');
    }

    @Post('bulk-assign')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Charge one head to many students (months a student already has are skipped)' })
    @RequireAction('extracurricular.student_charges#bulk_assign')
    async bulkAssign(@Body() dto: EcBulkAssignDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.bulkAssign(user, dto), HttpStatus.OK, 'Charges added');
    }

    @Post('bulk-remove/preview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'What a bulk remove would take off, without changing anything' })
    @RequireAction('extracurricular.student_charges#bulk_remove')
    async bulkRemovePreview(@Body() dto: EcBulkRemoveDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.bulkRemovePreview(user, dto), HttpStatus.OK, 'Bulk remove preview');
    }

    @Post('bulk-remove')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Remove one head from many students (only charges not yet on a voucher)' })
    @RequireAction('extracurricular.student_charges#bulk_remove')
    async bulkRemove(@Body() dto: EcBulkRemoveDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.bulkRemove(user, dto), HttpStatus.OK, 'Charges removed');
    }

    @Get('student/:cc')
    @ApiOperation({ summary: "A student's extracurricular charges" })
    @RequireAction('extracurricular.student_charges#view')
    async listForStudent(
        @Param('cc', ParseIntPipe) cc: number,
        @Query() query: EcStudentChargesQueryDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.listForStudent(user, cc, query.academic_years), HttpStatus.OK, 'Charges fetched');
    }

    @Get('student/:cc/class-amounts')
    @ApiOperation({ summary: "Active heads with this student's class amount for a year" })
    @RequireAction('extracurricular.student_charges#view')
    async classAmounts(
        @Param('cc', ParseIntPipe) cc: number,
        @Query() query: EcClassAmountsQueryDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.classAmountsForStudent(user, cc, query.academic_year), HttpStatus.OK, 'Class amounts fetched');
    }

    @Post('student/:cc/save')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Save a student's charges for one year (set, add or remove cells)" })
    @RequireAction('extracurricular.student_charges#edit')
    async save(
        @Param('cc', ParseIntPipe) cc: number,
        @Body() dto: SaveEcStudentChargesDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.save(user, cc, dto), HttpStatus.OK, 'Charges saved');
    }
}
