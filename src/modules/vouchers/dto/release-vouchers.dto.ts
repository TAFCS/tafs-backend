import { IsArray, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class ReleaseVouchersDto {
    @IsArray()
    @Type(() => Number)
    @IsInt({ each: true })
    ids: number[];
}
