import { student_status } from '@prisma/client';

/** TAFSD-527. Kept apart from the service so other modules can import them freely. */
export const UNIFORM_PHOTO_ACTION = { tileId: 'student.directory', actionId: 'uniform_photo' } as const;
export const UNIFORM_PHOTO_ACTION_KEY = `${UNIFORM_PHOTO_ACTION.tileId}#${UNIFORM_PHOTO_ACTION.actionId}`;
export const UNIFORM_PHOTO_REMINDER_KIND = 'UNIFORM_PHOTO_REMINDER';
/** First CC the flag applies to: everyone registered after Ayan Jahangir (CC 7525). */
export const UNIFORM_PHOTO_FROM_CC = 7526;
/** Only students who are actually attending need chasing. */
export const UNIFORM_PHOTO_STATUSES: student_status[] = [student_status.ENROLLED];
export const UNIFORM_PHOTO_LINK = '/identity/students?uniform_photo=pending';
