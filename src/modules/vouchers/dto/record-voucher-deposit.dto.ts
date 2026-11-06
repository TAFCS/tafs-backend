import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsInt,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
} from 'class-validator';

class SurchargeAllocationDto {
    @Type(() => Number)
    @IsInt()
    surcharge_id: number;

    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    amount: number;
}

export class RecordVoucherDepositDto {
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    amount: number;

    @IsObject()
    distributions: Record<string, number>;

    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @IsOptional()
    late_fee?: number;

    @IsString()
    @IsOptional()
    payment_method?: string;

    @IsString()
    @IsOptional()
    reference_number?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SurchargeAllocationDto)
    @IsOptional()
    surcharge_allocations?: SurchargeAllocationDto[];

    // TAFSD-421: part of `amount` left over after the voucher is cleared, kept as
    // family credit. Needs finance.receive_deposit#record_excess.
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    @IsOptional()
    excess_amount?: number;

    // TAFSD-421: pay this deposit from the family's credit, with no new cash.
    // Needs finance.receive_deposit#pay_from_credit.
    @IsBoolean()
    @IsOptional()
    pay_from_credit?: boolean;
}