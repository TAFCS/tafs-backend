import { IsArray, IsNumber, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class DepositAllocationDto {
    @IsNumber()
    student_fee_id: number;

    @IsNumber()
    amount: number;
}

class LateFeeAllocationDto {
    @IsNumber()
    voucher_id: number;

    @IsNumber()
    amount: number;
}

export class StudentDepositDto {
    @IsNumber()
    student_id: number;

    @IsNumber()
    total_deposited_amount: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => DepositAllocationDto)
    allocations: DepositAllocationDto[];

    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => LateFeeAllocationDto)
    late_fee_allocations?: LateFeeAllocationDto[];

    @IsOptional()
    @IsNumber()
    voucher_id?: number;
}
