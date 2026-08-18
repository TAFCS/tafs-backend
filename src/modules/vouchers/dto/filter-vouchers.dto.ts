import { ApiPropertyOptional } from '@nestjs/swagger';
import { student_status } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString } from 'class-validator';

export class FilterVouchersDto {
    @ApiPropertyOptional({ description: 'Filter by Student CC' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    student_id?: number;

    @ApiPropertyOptional({ description: 'Filter by Campus ID(s), comma-separated for multiple' })
    @IsOptional()
    @IsString()
    campus_id?: string;

    @ApiPropertyOptional({ description: 'Filter by Voucher Status (e.g. UNPAID, PAID, OVERDUE, VOID, EXPIRED), comma-separated for multiple' })
    @IsOptional()
    @IsString()
    status?: string;

    @ApiPropertyOptional({ description: 'Filter by Class ID(s), comma-separated for multiple' })
    @IsOptional()
    @IsString()
    class_id?: string;

    @ApiPropertyOptional({ description: 'Filter by Section ID(s), comma-separated for multiple' })
    @IsOptional()
    @IsString()
    section_id?: string;

    @ApiPropertyOptional({ description: 'Filter by exact Student CC number' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    cc?: number;

    @ApiPropertyOptional({ description: 'Filter by Student GR Number' })
    @IsOptional()
    @IsString()
    gr?: string;

    @ApiPropertyOptional({ description: 'Filter by exact Voucher ID' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    id?: number;

    @ApiPropertyOptional({ description: 'Filter vouchers with fee_date on or after this date (ISO 8601, e.g. 2026-03-01)' })
    @IsOptional()
    @IsISO8601()
    date_from?: string;

    @ApiPropertyOptional({ description: 'Filter vouchers with fee_date on or before this date (ISO 8601, e.g. 2026-03-10)' })
    @IsOptional()
    @IsISO8601()
    date_to?: string;

    @ApiPropertyOptional({ description: 'Page number for pagination', default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Number of items per page', default: 50 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    limit?: number = 50;

    @ApiPropertyOptional({ description: 'Show only vouchers whose heads all share a single fee_date' })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    single_fee_date?: boolean;

    @ApiPropertyOptional({ description: 'Show only vouchers whose heads span more than one distinct fee_date' })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    multiple_fee_heads?: boolean;

    /**
     * How campus_id / class_id / section_id are matched.
     *
     * A voucher snapshots the student's campus/class/section at generation time
     * and those columns are never rewritten afterwards — the printed voucher and
     * the frozen paid PDF must keep saying where the student actually sat when
     * they were billed. That makes the snapshot the wrong thing to filter on for
     * the common admin question ("show me this year's SR3 vouchers"), because a
     * student promoted out of SR3 still matches and a student promoted into SR3
     * has their earlier vouchers hidden.
     *
     * - 'current'   (default) → match the student's CURRENT campus/class/section.
     *                Consistent with bulk voucher generation and financial
     *                reports, which both filter the students table.
     * - 'as_issued' → match the voucher's own snapshot columns, i.e. who was
     *                billed under that class at the time.
     */
    /**
     * Filters on the student's CURRENT status, independent of class_scope — a
     * voucher carries no status of its own. Chiefly there to separate students
     * who have actually left from those still sitting in the class: a LEFT or
     * EXPELLED student keeps their class_id, so a class filter alone still
     * returns them.
     */
    @ApiPropertyOptional({
        description: 'Filter by the student\'s current status, comma-separated for multiple (e.g. ENROLLED,LEFT)',
        enum: student_status,
        isArray: true,
    })
    @IsOptional()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? value.split(',').map((v) => v.trim()).filter(Boolean)
            : value,
    )
    @IsArray()
    @IsEnum(student_status, { each: true })
    student_status?: student_status[];

    @ApiPropertyOptional({
        description:
            "Whether campus/class/section match the student's current placement ('current', default) or the voucher's snapshot at issue time ('as_issued')",
        enum: ['current', 'as_issued'],
        default: 'current',
    })
    @IsOptional()
    @IsIn(['current', 'as_issued'])
    class_scope?: 'current' | 'as_issued' = 'current';
}
