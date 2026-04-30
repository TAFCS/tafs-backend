import { IsArray, IsInt } from 'class-validator';

export class BulkDeleteVouchersDto {
    @IsArray()
    @IsInt({ each: true })
    ids: number[];
}
