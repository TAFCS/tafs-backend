import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { FeeChallanPDF } from './FeeChallanPDF';
import type { VoucherPdfData } from './voucher-pdf.types';

// Renders "DD-MM-YYYY hh:mm AM/PM" in Pakistan Standard Time, independent of
// the host machine's system timezone (which may be UTC in production).
function formatPktTimestamp(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Karachi',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    }).formatToParts(date);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

/**
 * CPU-bound @react-pdf/renderer work. Called from a Piscina worker in
 * production; the service may also call this in-process as a fallback when
 * the compiled worker file is missing (jest / ts-node).
 */
export async function renderVoucherPdf(data: VoucherPdfData): Promise<Buffer> {
    const props = {
        student: {
            cc: data.student.cc,
            student_full_name: data.student.fullName,
            gr_number: data.student.grNumber,
            campus: data.campusName,
            class_id: data.student.classId,
            className: data.student.className,
            sectionName: data.student.sectionName,
            grade_and_section: `${data.student.className} - ${data.student.sectionName}`,
            gender: data.student.gender,
            father_name: data.student.fatherName,
        },
        details: {
            month: data.month,
            academicYear: data.academicYear,
            issueDate: data.issueDate,
            dueDate: data.dueDate,
            validityDate: data.validityDate,
            applyLateFee: data.lateFeeAmount > 0,
            lateFeeAmount: data.lateFeeAmount,
            applyReprintFee: data.reprintFeeAmount > 0,
            reprintFeeAmount: data.reprintFeeAmount,
            voucherNumber: data.voucherNumber,
            generatedBy: {
                fullName: data.generatedByName || 'TAFSync System',
                // Prefer the persisted generation timestamp; fall back to
                // issue date for legacy vouchers that predate the columns.
                // Never use "now" — regenerations must not rewrite the stamp.
                timestampStr: formatPktTimestamp(
                    data.generatedAt
                        ? new Date(data.generatedAt)
                        : data.issueDate
                          ? new Date(data.issueDate)
                          : new Date(0),
                ),
            },
            bank: {
                name: data.bank.name,
                title: data.bank.title,
                account: data.bank.account,
                branch: '',
                address: data.bank.address,
                iban: data.bank.iban,
            },
            surchargeWaived: data.surchargeWaived,
            totalSurcharge: data.totalSurcharge,
            arrearsLabel: data.arrearsLabel,
        },
        fees: data.feeHeads.map((f) => ({
            description: f.description,
            amount: f.amount,
            netAmount: f.netAmount,
            discount: f.discount,
            amountAfterDiscount: f.amountAfterDiscount,
            scholarship: f.scholarship,
            scholarshipPercentage: f.scholarshipPercentage,
            discountLabel: f.discountLabel,
            isArrear: f.isArrear,
            feeDate: f.feeDate,
        })),
        totalAmount: data.totalAmount,
        showDiscount: data.showDiscount ?? true,
        paidStamp: data.paidStamp ?? false,
        siblings: data.siblings
            ?.filter((s) => s.cc !== data.student.cc)
            .map((s) => ({
                full_name: s.fullName,
                cc: s.cc,
                gr_number: s.grNumber,
                className: s.className,
                sectionName: s.sectionName,
            })),
        qrUrl: data.qrUrl,
        arrearsHistory: data.arrearsHistory,
        installmentsHistory: data.installmentsHistory,
        paymentHistory: data.paymentHistory,
    };

    const reactElement = React.createElement(FeeChallanPDF, props) as any;
    const pdfBuffer = await renderToBuffer(reactElement);
    return Buffer.from(pdfBuffer);
}
