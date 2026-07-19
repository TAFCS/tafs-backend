import { SectionGenderMode } from '@prisma/client';
import { NormalizedGender } from './gender-normalization';

export const ALLOCATION_ERROR_CODES = {
  SECTION_NOT_OFFERED: 'SECTION_NOT_OFFERED',
  SECTION_INACTIVE: 'SECTION_INACTIVE',
  SECTION_FULL: 'SECTION_FULL',
  SECTION_GENDER_RESTRICTED: 'SECTION_GENDER_RESTRICTED',
  STUDENT_GENDER_REQUIRED: 'STUDENT_GENDER_REQUIRED',
  CAMPUS_CLASS_INACTIVE: 'CAMPUS_CLASS_INACTIVE',
  PLACEMENT_INCOMPLETE: 'PLACEMENT_INCOMPLETE',
} as const;

export type AllocationErrorCode =
  (typeof ALLOCATION_ERROR_CODES)[keyof typeof ALLOCATION_ERROR_CODES];

export interface PlacementTarget {
  campusId: number;
  classId: number;
  sectionId: number;
}

export interface PlacementStudentContext {
  /** Student CC; used to exclude the moving student from occupancy. */
  studentCc?: number | null;
  gender?: string | null;
  /**
   * When true, the student is already ENROLLED (or will count as enrolled after
   * this placement). Soft admissions transitioning to ENROLLED should pass true.
   */
  countsTowardCapacity?: boolean;
}

export interface SectionOccupancyStats {
  enrolled_count: number;
  male_count: number;
  female_count: number;
  unknown_count: number;
  remaining_seats: number | null;
  is_full: boolean;
  capacity_conflict_count: number;
  gender_conflict_count: number;
}

export interface CampusSectionRules {
  campus_section_id: number;
  campus_id: number;
  class_id: number;
  section_id: number;
  is_active: boolean | null;
  student_capacity: number | null;
  gender_mode: SectionGenderMode;
}

export interface GenderBreakdown {
  male: number;
  female: number;
  unknown: number;
}

export type GenderBucket = NormalizedGender;
