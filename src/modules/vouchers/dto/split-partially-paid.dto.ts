import { IsISO8601, IsNotEmpty, IsOptional } from 'class-validator';

export class SplitPartiallyPaidDto {
    @IsISO8601()
    @IsNotEmpty()
    issue_date!: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date!: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;
}
