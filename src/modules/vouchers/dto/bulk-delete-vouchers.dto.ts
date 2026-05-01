import { IsArray, IsInt, IsBoolean, IsOptional } from 'class-validator';

export class BulkDeleteVouchersDto {
    @IsArray()
    @IsInt({ each: true })
    ids: number[];

    @IsBoolean()
    @IsOptional()
    force?: boolean;   // when true: bypasses status guard, deletes PAID too
}
