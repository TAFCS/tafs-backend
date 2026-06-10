import { IsNumber, IsObject } from 'class-validator';

export class CreateChangeRequestDto {
  @IsNumber()
  guardian_id: number;

  @IsNumber()
  family_id: number;

  @IsObject()
  requested_data: Record<string, unknown>;
}
