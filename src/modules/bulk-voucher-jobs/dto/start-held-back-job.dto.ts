import { ArrayMinSize, IsArray, IsInt, IsOptional } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { StartBulkJobDto } from './start-bulk-job.dto';

/**
 * TAFSD-547: POST /bulk-voucher-jobs/:id/held-back. The same settings as a new
 * bulk job (the webapp prefills them from the original job), but the students
 * come from the original job's HELD_BACK_ARREARS rows, not from the caller.
 * `student_ccs` may narrow that list; it can never add a student to it.
 */
export class StartHeldBackJobDto extends OmitType(StartBulkJobDto, ['student_ccs'] as const) {
    @IsArray()
    @IsInt({ each: true })
    @ArrayMinSize(1)
    @IsOptional()
    student_ccs?: number[];
}
