import { PartialType } from '@nestjs/mapped-types';
import { CreateClassFeeScheduleDto } from './create-class-fee-schedule.dto';

export class UpdateClassFeeScheduleDto extends PartialType(CreateClassFeeScheduleDto) {}
