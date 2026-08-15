import { ArrayNotEmpty, Equals, IsArray, IsIn, IsInt, IsString, Matches } from 'class-validator';

/**
 * Move fee heads into a different academic year.
 *
 * `academic_year` and `term_start_month` are always written together — never
 * expose a year-only edit. "June of 2025-2026" is Jun 2026 under an Aug-Jul
 * term and Jun 2025 under an Apr-Mar one, so moving the year while leaving the
 * term to be inferred sends the head a year further out than the bug this
 * feature exists to fix: an April head repointed to 2026-2027 but still
 * resolving through an Aug-Jul class renders as Apr 2027.
 */
export class TransferHeadsDto {
    @IsArray()
    @ArrayNotEmpty()
    @IsInt({ each: true })
    student_fee_ids: number[];

    @IsString()
    @Matches(/^\d{4}-\d{4}$/, { message: 'target_academic_year must look like 2026-2027' })
    target_academic_year: string;

    /** 8 = Aug-Jul, 4 = Apr-Mar. The only two terms the school runs. */
    @IsInt()
    @IsIn([4, 8])
    target_term_start_month: number;

    /**
     * The admin has seen the preview and its risk flags. Rejected unless true —
     * this rewrites records that may already be paid and receipted.
     */
    @Equals(true, { message: 'acknowledgement is required to transfer fee heads' })
    acknowledgement: boolean;
}
