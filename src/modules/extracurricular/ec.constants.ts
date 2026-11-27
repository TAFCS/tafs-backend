/**
 * TAFSD-605: extracurricular (EC) fees. Tile ids, payment methods, switches and
 * caps live here so each rule has one home. The rules themselves: ./CLAUDE.md.
 */

/** Tile ids of the Extracurricular Fees module (tiles.manifest.ts, module `extracurricular`). */
export const EC_TILE = {
    feeHeads: 'extracurricular.fee_heads',
    classSchedule: 'extracurricular.class_schedule',
    studentCharges: 'extracurricular.student_charges',
    singleVoucher: 'extracurricular.single_voucher',
    vouchers: 'extracurricular.vouchers',
} as const;

/**
 * Every EC tile that exists in the manifest today. Shared feeders (the fee-head
 * picker) let in a caller holding any of them. Add a tile here in the same
 * change that adds it to the manifest; the access spec checks the two agree.
 */
export const EC_LIVE_TILES: string[] = [
    EC_TILE.feeHeads,
    EC_TILE.classSchedule,
    EC_TILE.studentCharges,
    EC_TILE.singleVoucher,
    EC_TILE.vouchers,
];

/** A new voucher is valid through this many days after its issue date unless told otherwise. */
export const EC_DEFAULT_VALIDITY_DAYS = 15;

/** Bump whenever EcChallanPDF.tsx changes, so every cached unpaid render is redrawn. */
export const EC_PDF_TEMPLATE_VERSION = 1;

/** Search feeders return at most this many rows (webapp Rule 2). */
export const EC_SEARCH_LIMIT = 20;

/** A class-amount save carries at most this many cells. */
export const EC_SCHEDULE_MAX_CELLS = 2000;

/** Advisory-lock key for class-amount writes (null-campus rows are not unique in Postgres). */
export const EC_SCHEDULE_LOCK_KEY = 'ec_class_fee_schedule';
