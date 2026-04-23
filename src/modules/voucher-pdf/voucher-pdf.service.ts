import { Injectable, Logger } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { PDFDocument } from 'pdf-lib';
import * as React from 'react';
import { FeeChallanPDF } from './FeeChallanPDF';

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
        netAmount: number;
        discountLabel?: string;
        isArrear?: boolean;
    }>;
    totalAmount: number;
    lateFeeAmount: number;
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
    }>;
    surchargeWaived?: boolean;
    totalSurcharge?: number;
}

@Injectable()
export class VoucherPdfService {
    private readonly logger = new Logger(VoucherPdfService.name);

    /**
     * Generates a 3-copy (Bank, School, Student) Landscape A4 PDF with a Siblings Info sidebar,
     * utilizing the exact same React Component used on the frontend to ensure 100% visual parity.
     */
    async generateVoucherPdf(data: VoucherPdfData): Promise<Buffer> {
        this.logger.debug(`Generating React-PDF for voucher ${data.voucherNumber} (CC: ${data.student.cc})`);

        // Map the backend DTO into the exact shape expected by the React Component
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
                voucherNumber: data.voucherNumber,
                generatedBy: {
                    fullName: 'TAFSync Bulk Engine',
                    timestampStr: new Date().toLocaleString()
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
            },
            fees: data.feeHeads.map(f => ({
                description: f.description,
                amount: f.amount,
                netAmount: f.netAmount,
                discount: f.discount,
                discountLabel: f.discountLabel,
                isArrear: f.isArrear,
            })),
            totalAmount: data.totalAmount,
            showDiscount: data.showDiscount ?? true,
            paidStamp: data.paidStamp ?? false,
            siblings: data.siblings?.filter(s => s.cc !== data.student.cc).map(s => ({
                full_name: s.fullName,
                cc: s.cc,
                gr_number: s.grNumber,
                className: s.className,
                sectionName: s.sectionName,
            })),
            qrUrl: data.qrUrl,
            arrearsHistory: data.arrearsHistory,
        };

        try {
            const reactElement = React.createElement(FeeChallanPDF, props) as any;
            const pdfBuffer = await renderToBuffer(reactElement);
            return Buffer.from(pdfBuffer);
        } catch (error) {
            this.logger.error(`Failed to generate React-PDF for ${data.voucherNumber}`, error);
            throw error;
        }
    }

    async mergePdfs(pdfBuffers: Buffer[]): Promise<Buffer> {
        const mergedPdf = await PDFDocument.create();

        for (const buffer of pdfBuffers) {
            const doc = await PDFDocument.load(buffer);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((p) => mergedPdf.addPage(p));
        }

        const mergedPdfBytes = await mergedPdf.save();
        return Buffer.from(mergedPdfBytes);
    }
}
