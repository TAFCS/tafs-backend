export type HierarchyMode = 'off' | 'view' | 'enforce';

export interface BelowOptions {
  /** Maximum traversal depth. Omit or undefined for unlimited (all descendants). */
  depth?: number;
}

export interface HierarchyReportMismatch {
  managerId: number;
  managerName: string;
  managerRole?: string | null;
  reportId: number;
  reportName: string;
  reportCampus?: { id: number; name: string } | null;
  reportSegment?: { id: number; name: string } | null;
  reportDepartment?: { id: number; name: string } | null;
  mismatchedDimensions: ('campus' | 'segment' | 'department')[];
  reason: string;
}

export interface DeskMemberMismatch {
  queueId: number;
  queueName: string;
  deskCampus?: { id: number; name: string } | null;
  memberUserId: string;
  memberEmployeeId?: number | null;
  memberName: string;
  reason: string;
}

export interface ScopeMismatchReport {
  managerReportMismatches: HierarchyReportMismatch[];
  deskMemberMismatches: DeskMemberMismatch[];
  totalMismatches: number;
}
