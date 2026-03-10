import { IsISO8601, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateVoucherDto {
    @IsISO8601()
    @IsOptional()
    issue_date?: string;

    @IsISO8601()
    @IsOptional()
    due_date?: string;

    @IsString()
    @MaxLength(20)
    @IsOptional()
    status?: string;

    @IsInt()
    @IsOptional()
    bank_account_id?: number;
}
