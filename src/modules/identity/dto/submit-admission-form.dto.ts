import {
    IsString,
    IsInt,
    IsOptional,
    IsNotEmpty,
    IsBoolean,
    IsArray,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AcademicSystem, GuardianDto, PreviousSchoolDto } from './create-admission.dto';

export class StudentLanguageDto {
    @IsString()
    @IsNotEmpty()
    language_name: string;

    @IsBoolean()
    can_speak: boolean;

    @IsBoolean()
    can_read: boolean;

    @IsBoolean()
    can_write: boolean;
}

export class StudentSiblingDto {
    @IsString()
    @IsNotEmpty()
    full_name: string;

    @IsString()
    @IsNotEmpty()
    relationship: string;

    @IsOptional()
    age?: number;

    @IsString()
    @IsOptional()
    current_school?: string;

    @IsBoolean()
    @IsOptional()
    pick_and_drop?: boolean;
}

export class RelativeAttendingDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    class: string;

    @IsString()
    @IsNotEmpty()
    relationship: string;
}

export class StudentActivityDto {
    @IsString()
    @IsNotEmpty()
    activity_name: string;

    @IsString()
    @IsOptional()
    grade?: string;

    @IsString()
    @IsOptional()
    honors_awards?: string;

    @IsBoolean()
    @IsOptional()
    continue_at_tafs?: boolean;
}

export class SubmitAdmissionFormDto {
    @IsInt()
    @IsNotEmpty()
    cc: number;

    @IsString()
    @IsOptional()
    gr_number?: string;

    @IsString()
    @IsOptional()
    gender?: string;

    @IsString()
    @IsOptional()
    religion?: string;

    @IsString()
    @IsOptional()
    nationality?: string;

    @IsString()
    @IsOptional()
    identification_marks?: string;

    @IsString()
    @IsOptional()
    physical_impairment?: string;

    @IsString()
    @IsOptional()
    medical_info?: string;

    @IsString()
    @IsOptional()
    interests?: string;

    @IsOptional()
    admission?: {
        academic_system: string;
        requested_grade: string;
        academic_year?: string;
        discipline?: string;
    };

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PreviousSchoolDto)
    @IsOptional()
    previous_schools?: PreviousSchoolDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => StudentLanguageDto)
    @IsOptional()
    languages?: StudentLanguageDto[];

    @ValidateNested()
    @Type(() => GuardianDto)
    @IsOptional()
    father?: GuardianDto;

    @ValidateNested()
    @Type(() => GuardianDto)
    @IsOptional()
    mother?: GuardianDto;

    @ValidateNested()
    @Type(() => GuardianDto)
    @IsOptional()
    guardian?: GuardianDto;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => StudentSiblingDto)
    @IsOptional()
    siblings?: StudentSiblingDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => RelativeAttendingDto)
    @IsOptional()
    relatives?: RelativeAttendingDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => StudentActivityDto)
    @IsOptional()
    activities?: StudentActivityDto[];
}
