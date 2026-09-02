export interface VoucherPdfData {
    voucherNumber: string;
    student: {
        cc: number;
        classId: number;
        fullName: string;
        fatherName: string;
        gender: string;
        grNumber: string;
        className: string;
        sectionName: string;
    };
    siblings?: Array<{
        cc: number;
        fullName: string;
        grNumber: string;
        className: string;
        sectionName: string;
    }>;
    campusName: string;
    academicYear: string;
    month: string;
    issueDate: string;
    dueDate: string;
    validityDate: string;
    bank: {
        name: string;
        title: string;
        account: string;
        iban: string;
        address: string;
    };
    feeHeads: Array<{
        description: string;
        amount: number;
        discount?: number;
        amountAfterDiscount?: number;
        scholarship?: number;
        scholarshipPercentage?: number | null;
        netAmount: number;
        discountLabel?: string;
        isArrear?: boolean;
        feeDate?: string;
    }>;
    totalAmount: number;
    lateFeeAmount: number;
    reprintFeeAmount: number;
    generatedByName?: string;
    /** Stamp recorded when the voucher was first generated — used for the PDF footer. */
    generatedAt?: Date | string;
    /** When true, overlay a PAID stamp on all three challan copies */
    paidStamp?: boolean;
    /** When false, hide the discount column. Default: true */
    showDiscount?: boolean;
    /** Portal URL to encode in QR code on each challan copy */
    qrUrl?: string;
    /** Rows shown in the ARREAR'S HISTORY sidebar column */
    arrearsHistory?: Array<{
        date: string;
        head: string;
        amount: string;
        totalAmount: string;
        target_month?: number;
        academic_year?: string;
        /**
         * Rendered month+year, e.g. "JUN 26". Resolved server-side because only
         * prepareVoucherPdfData knows the term each head was written under; the
         * PDF components can see the student's current class at best. Null when
         * the row carries no month — the components fall back to `date`.
         */
        monthLabel?: string | null;
    }>;
    surchargeWaived?: boolean;
    totalSurcharge?: number;
    /** Consolidated month-range label, e.g. "ARREARS (AUG 25 – OCT 25)" */
    arrearsLabel?: string;
    installmentsHistory?: Array<{ head: string; month: string; amount: number; status: string }>;
    paymentHistory?: Array<{ date: string; head: string; amount: string; totalAmount: string; payment_method?: string | null }>;
}
