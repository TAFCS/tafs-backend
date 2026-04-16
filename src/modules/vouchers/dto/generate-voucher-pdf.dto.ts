import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class GenerateVoucherPdfDto {
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    show_discount?: boolean;

    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    paid_stamp?: boolean;
}
