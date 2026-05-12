import { IsNumber, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateGuardianDto } from '../../staff-editing/dto/update-guardian.dto';

export class CreateChangeRequestDto {
  @IsNumber()
  guardian_id: number;

  @IsNumber()
  family_id: number;

  @IsObject()
  @ValidateNested()
  @Type(() => UpdateGuardianDto)
  requested_data: UpdateGuardianDto;
}
