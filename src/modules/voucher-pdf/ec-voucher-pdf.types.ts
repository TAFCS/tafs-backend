/**
 * TAFSD-605: everything the extracurricular challan prints. Built by
 * extracurricular/vouchers/ec-voucher-pdf.service.ts from the ec_* tables, and
 * rendered by EcChallanPDF.tsx. Plain JSON so it can cross the worker boundary.
 */
export interface EcVoucherPdfData {
    voucherNumber: string;
    student: {
        cc: number;
        fullName: string;
        fatherName: string;
        gender: string;
        grNumber: string;
        className: string;
        sectionName: string;
        houseName: string;
    };
    campusName: string;
    academicYear: string;
    /** "SEP 26 - NOV 26", from the line periods. */
    monthsLabel: string;
    /** YYYY-MM-DD */
    issueDate: string;
    /** YYYY-MM-DD; valid through this whole day. */
    expiryDate: string;
    bank: { name: string; title: string; account: string; iban: string; address: string };
    lines: { description: string; amount: number }[];
    totalAmount: number;
    amountPaid: number;
    amountWaived: number;
    balance: number;
    /** One diagonal mark across the page (WAIVED / EXPIRED); PAID is stamped on each copy. */
    stamp: 'PAID' | 'WAIVED' | 'EXPIRED' | null;
    /** The student's other open EC vouchers: listed beside this one, never added to it. */
    otherOpenVouchers: { voucherNumber: string; validTill: string; lapsed: boolean; balance: number }[];
    /** The student's last EC payments, newest first. */
    payments: { date: string; voucherNumber: string; method: string; amount: number }[];
    siblings: { cc: number; fullName: string; grNumber: string; className: string; sectionName: string }[];
    generatedByName: string;
    /** ISO timestamp the voucher was issued; printed, never "now". */
    generatedAt: string;
    /** The PDF's own public URL, for the QR code. Not part of the cache hash. */
    qrUrl?: string;
}
