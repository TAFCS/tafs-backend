import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';

export interface VoucherPdfData {
    voucherNumber: string;
    student: {
        cc: number;
        fullName: string;
        grNumber: string;
        className: string;
        sectionName: string;
    };
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
    }>;
    totalAmount: number;
    lateFeeAmount: number;
}

@Injectable()
export class VoucherPdfService {
    private readonly logger = new Logger(VoucherPdfService.name);

    /**
     * Generates a 3-copy (Bank, School, Student) Landscape A4 PDF.
     */
    async generateVoucherPdf(data: VoucherPdfData): Promise<Buffer> {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([841.89, 595.28]); // A4 Landscape
        const { width, height } = page.getSize();

        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const colWidth = width / 3;
        const padding = 15;

        // Embed logo if exists
        let logoImage: any = null;
        try {
            const logoPath = path.join(process.cwd(), 'src/assets/logo.png');
            if (fs.existsSync(logoPath)) {
                const logoBytes = fs.readFileSync(logoPath);
                logoImage = await pdfDoc.embedPng(logoBytes);
            }
        } catch (e) {
            this.logger.warn('Could not embed logo.png in PDF');
        }

        const copies = ['Bank Copy', 'School Copy', 'Student Copy'];

        for (let i = 0; i < 3; i++) {
            const xOffset = i * colWidth;
            this.drawCopy(page, xOffset, colWidth, height, padding, copies[i], data, font, boldFont, logoImage);

            // Draw divider line if not the last copy
            if (i < 2) {
                page.drawLine({
                    start: { x: xOffset + colWidth, y: 10 },
                    end: { x: xOffset + colWidth, y: height - 10 },
                    thickness: 1,
                    dashArray: [5, 5],
                    color: rgb(0.8, 0.8, 0.8),
                });
            }
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    }

    /**
     * Merges multiple PDF buffers into a single PDF.
     */
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

    private drawCopy(
        page: any,
        x: number,
        width: number,
        height: number,
        padding: number,
        copyType: string,
        data: VoucherPdfData,
        font: any,
        boldFont: any,
        logoImage: any,
    ) {
        let currentY = height - padding;

        // --- Copy Label ---
        page.drawText(copyType.toUpperCase(), {
            x: x + width - 60,
            y: currentY - 5,
            size: 7,
            font: boldFont,
            color: rgb(0.5, 0.5, 0.5),
        });

        // --- Header ---
        if (logoImage) {
            const logoSize = 30;
            page.drawImage(logoImage, {
                x: x + (width / 2) - (logoSize / 2),
                y: currentY - logoSize,
                width: logoSize,
                height: logoSize,
            });
            currentY -= (logoSize + 5);
        }

        const title = 'THE AMERICAN FOUNDATION SCHOOL';
        const titleWidth = boldFont.widthOfTextAtSize(title, 10);
        page.drawText(title, {
            x: x + (width / 2) - (titleWidth / 2),
            y: currentY - 10,
            size: 10,
            font: boldFont,
        });
        currentY -= 15;

        const campusStr = (data.campusName || 'Main Campus').toUpperCase();
        const campusWidth = font.widthOfTextAtSize(campusStr, 7);
        page.drawText(campusStr, {
            x: x + (width / 2) - (campusWidth / 2),
            y: currentY - 8,
            size: 7,
            font: font,
            color: rgb(0.3, 0.3, 0.3),
        });
        currentY -= 20;

        // --- Student Info Box ---
        page.drawRectangle({
            x: x + padding,
            y: currentY - 50,
            width: width - (padding * 2),
            height: 50,
            borderColor: rgb(0.9, 0.9, 0.9),
            borderWidth: 1,
            color: rgb(0.98, 0.98, 0.98),
        });

        const drawField = (label: string, value: string, rowY: number, colX: number) => {
            page.drawText(label.toUpperCase(), { x: colX, y: rowY, size: 5, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
            page.drawText(value || 'N/A', { x: colX, y: rowY - 8, size: 7, font: boldFont });
        };

        drawField('Student Name', data.student.fullName, currentY - 8, x + padding + 5);
        drawField('Computer Code', data.student.cc.toString(), currentY - 8, x + padding + 150);
        drawField('GR Number', data.student.grNumber, currentY - 28, x + padding + 5);
        drawField('Class / Section', `${data.student.className} - ${data.student.sectionName}`, currentY - 28, x + padding + 150);
        
        currentY -= 60;

        // --- Voucher Meta ---
        const drawMeta = (label: string, value: string, metaX: number) => {
            page.drawText(label.toUpperCase(), { x: metaX, y: currentY, size: 5, font: font, color: rgb(0.4, 0.4, 0.4) });
            page.drawText(value, { x: metaX, y: currentY - 8, size: 6.5, font: boldFont });
        };

        const metaColWidth = (width - (padding * 2)) / 4;
        drawMeta('Billing', data.month, x + padding);
        drawMeta('Issue Date', data.issueDate, x + padding + metaColWidth);
        drawMeta('Due Date', data.dueDate, x + padding + (metaColWidth * 2));
        drawMeta('Session', data.academicYear, x + padding + (metaColWidth * 3));
        
        page.drawText(`VOUCHER NO: ${data.voucherNumber}`, {
            x: x + padding,
            y: currentY - 22,
            size: 6,
            font: boldFont,
        });

        currentY -= 35;

        // --- Fee Table ---
        // Header
        page.drawLine({ start: { x: x + padding, y: currentY }, end: { x: x + width - padding, y: currentY }, thickness: 0.5 });
        page.drawText('Description', { x: x + padding, y: currentY - 10, size: 7, font: boldFont });
        page.drawText('Amount', { x: x + width - padding - 40, y: currentY - 10, size: 7, font: boldFont, textAlign: 'right' });
        currentY -= 15;
        page.drawLine({ start: { x: x + padding, y: currentY }, end: { x: x + width - padding, y: currentY }, thickness: 0.5 });

        for (const head of data.feeHeads) {
            page.drawText(head.description, { x: x + padding, y: currentY - 10, size: 6.5, font: font });
            const amtStr = head.netAmount.toLocaleString();
            page.drawText(amtStr, { x: x + width - padding - 10 - font.widthOfTextAtSize(amtStr, 6.5), y: currentY - 10, size: 6.5, font: font });
            currentY -= 12;
        }

        // Totals
        currentY -= 5;
        page.drawLine({ start: { x: x + padding, y: currentY }, end: { x: x + width - padding, y: currentY }, thickness: 0.5 });
        page.drawText('PAYABLE BY DUE DATE', { x: x + padding, y: currentY - 12, size: 7, font: boldFont });
        const totalStr = data.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 });
        page.drawText(totalStr, { x: x + width - padding - 10 - boldFont.widthOfTextAtSize(totalStr, 8), y: currentY - 12, size: 8, font: boldFont });
        currentY -= 20;

        if (data.lateFeeAmount > 0) {
            page.drawText('Late Payment Surcharge', { x: x + padding, y: currentY, size: 6, font: font });
            page.drawText(data.lateFeeAmount.toLocaleString(), { x: x + width - padding - 40, y: currentY, size: 6, font: font });
            currentY -= 12;

            page.drawText('PAYABLE AFTER DUE DATE', { x: x + padding, y: currentY, size: 7, font: boldFont, color: rgb(0.8, 0.1, 0.1) });
            const afterDueStr = (data.totalAmount + data.lateFeeAmount).toLocaleString(undefined, { minimumFractionDigits: 2 });
            page.drawText(afterDueStr, { x: x + width - padding - 10 - boldFont.widthOfTextAtSize(afterDueStr, 8), y: currentY, size: 8, font: boldFont, color: rgb(0.8, 0.1, 0.1) });
            currentY -= 15;
        }

        // --- Bank Info ---
        currentY -= 10;
        page.drawRectangle({
            x: x + padding,
            y: currentY - 30,
            width: width - (padding * 2),
            height: 30,
            color: rgb(0.95, 0.97, 1),
            borderColor: rgb(0.8, 0.8, 0.9),
            borderWidth: 0.5,
        });
        page.drawText('NOTE FOR BANK:', { x: x + padding + 5, y: currentY - 8, size: 5, font: boldFont });
        page.drawText(`FUNDS FOR A/C ${data.bank.account} (${data.bank.name})`, { x: x + padding + 5, y: currentY - 18, size: 6, font: font });
        page.drawText(`IBAN: ${data.bank.iban}`, { x: x + padding + 5, y: currentY - 26, size: 5, font: font });

        // --- Signature ---
        page.drawLine({
            start: { x: x + width - padding - 80, y: 35 },
            end: { x: x + width - padding, y: 35 },
            thickness: 0.5,
        });
        page.drawText('HEAD OF INSTITUTION', {
            x: x + width - padding - 75,
            y: 25,
            size: 5,
            font: boldFont,
        });

        page.drawText(`VALID UPTO: ${data.validityDate}`, {
            x: x + padding,
            y: 25,
            size: 6,
            font: boldFont,
            color: rgb(0.8, 0.1, 0.1),
        });
    }
}
