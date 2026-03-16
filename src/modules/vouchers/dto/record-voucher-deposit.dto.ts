import { Type } from 'class-transformer';
import { IsNumber, IsObject, IsOptional, Min } from 'class-validator';

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
}