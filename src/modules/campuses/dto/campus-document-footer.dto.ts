import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

/**
 * TAFSD-603: a campus's document footer, one entry a line, as saved or previewed. Blank lines
 * are dropped. The limits here are loose on purpose: the preview shows a draft as typed, with its
 * problems, and saving checks the cleaned lines (campus-footer.ts footerProblems).
 */
export class CampusDocumentFooterDto {
    @IsArray()
    @ArrayMaxSize(12)
    @IsString({ each: true })
    @MaxLength(400, { each: true })
    lines: string[];
}
