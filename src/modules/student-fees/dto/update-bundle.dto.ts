import { PartialType } from '@nestjs/mapped-types';
import { CreateBundleDto } from './create-bundle.dto';

/** PATCH /student-fees/bundles/:id: any subset of the create fields. */
export class UpdateBundleDto extends PartialType(CreateBundleDto) {}
