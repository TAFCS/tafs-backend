import { IsArray, IsInt } from 'class-validator';

export class SetCampusSegmentsDto {
  /** The complete set of segments this campus runs. Replaces whatever is stored. */
  @IsArray()
  @IsInt({ each: true })
  segment_ids: number[];
}
