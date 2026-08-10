import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type PrismaTx = Prisma.TransactionClient;

export type ProgressionChangeParams = {
  studentCc: number;
  campusId: number | null;
  classId: number | null;
  sectionId: number | null;
  houseId: number | null;
  academicYear: string | null;
  grNumber: string | null;
  changeType: string;
  changedBy: string | null;
  notes?: string | null;
  /** Override timestamp (used by backfill). Defaults to now. */
  at?: Date;
};

@Injectable()
export class ProgressionHistoryService {
  /**
   * Close the student's open placement period (if any) and open a new one
   * when campus/class/section/house actually changed. No-op otherwise.
   */
  async recordProgressionChange(
    tx: PrismaTx,
    params: ProgressionChangeParams,
  ): Promise<void> {
    const open = await tx.student_progression_periods.findFirst({
      where: { student_cc: params.studentCc, valid_to: null },
    });

    const unchanged =
      open &&
      open.campus_id === params.campusId &&
      open.class_id === params.classId &&
      open.section_id === params.sectionId &&
      open.house_id === params.houseId &&
      open.change_type === params.changeType;

    if (unchanged) return;

    const now = params.at ?? new Date();

    if (open) {
      await tx.student_progression_periods.update({
        where: { id: open.id },
        data: { valid_to: now },
      });
    }

    await tx.student_progression_periods.create({
      data: {
        student_cc: params.studentCc,
        campus_id: params.campusId,
        class_id: params.classId,
        section_id: params.sectionId,
        house_id: params.houseId,
        academic_year: params.academicYear,
        gr_number: params.grNumber,
        change_type: params.changeType,
        changed_by: params.changedBy,
        notes: params.notes ?? null,
        valid_from: now,
        valid_to: null,
      },
    });
  }

  /** Prefer HOUSE_CHANGED when only house_id differs from the prior placement. */
  resolveChangeType(params: {
    prior: {
      campus_id: number | null;
      class_id: number | null;
      section_id: number | null;
      house_id: number | null;
    } | null;
    next: {
      campusId: number | null;
      classId: number | null;
      sectionId: number | null;
      houseId: number | null;
    };
    defaultType: string;
  }): string {
    if (!params.prior) return params.defaultType;

    const campusSame = params.prior.campus_id === params.next.campusId;
    const classSame = params.prior.class_id === params.next.classId;
    const sectionSame = params.prior.section_id === params.next.sectionId;
    const houseSame = params.prior.house_id === params.next.houseId;

    if (campusSame && classSame && sectionSame && !houseSame) {
      return 'HOUSE_CHANGED';
    }
    return params.defaultType;
  }
}
