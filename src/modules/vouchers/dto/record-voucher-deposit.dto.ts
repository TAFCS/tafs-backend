import { Type } from 'class-transformer';
import {
    IsArray,
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
}