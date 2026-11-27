import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../../../prisma/prisma.service';
import { StorageService } from '../../../common/storage/storage.service';
import { challanClassLabel } from '../../voucher-pdf/challan-class-label';
import type { EcVoucherPdfData } from '../../voucher-pdf/ec-voucher-pdf.types';
import { VoucherPdfService } from '../../voucher-pdf/voucher-pdf.service';
import { isFatherRelationship } from '../../vouchers/invalidate-unpaid-pdfs';
import { EC_PDF_TEMPLATE_VERSION } from '../ec.constants';
import type { EcBankSnapshot } from '../ec-issue';
import { dateKey, ecPeriodLabel, todayPktKey } from '../ec-dates.util';
import { ecVoucherState } from '../ec-voucher-state';

const PDF_SELECT = {
    id: true,
    voucher_number: true,
    student_id: true,
    academic_year: true,
    issue_date: true,
    expiry_date: true,
    status: true,
    total_amount: true,
    amount_paid: true,
    amount_waived: true,
    bank_snapshot: true,
    generated_by_name: true,
    created_at: true,
    pdf_url: true,
    pdf_hash: true,
    paid_pdf_url: true,
    paid_pdf_filename: true,
    reissued_to: { select: { id: true } },
    campuses: { select: { campus_name: true } },
    classes: { select: { class_code: true, description: true } },
    sections: { select: { description: true } },
    ec_voucher_lines: {
        select: { description: true, amount: true, ec_student_charges: { select: { period: true } } },
        orderBy: { sort_order: 'asc' as const },
    },
    students: {
        select: {
            cc: true,
            full_name: true,
            gr_number: true,
            gender: true,
            family_id: true,
            houses: { select: { house_name: true, house_color: true } },
            student_guardians: { select: { relationship: true, guardians: { select: { full_name: true } } } },
        },
    },
} as const;

/** JSON with keys sorted, so equal data always hashes the same. */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value as object)
            .sort()
            .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

/** "SEP 26 - NOV 26" for consecutive months, else a list. */
export function ecMonthsLabel(periods: Date[]): string {
    const keys = [...new Set(periods.map((p) => p.getUTCFullYear() * 12 + p.getUTCMonth()))].sort((a, b) => a - b);
    if (!keys.length) return '-';
    const label = (k: number) => ecPeriodLabel(new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)));
    const consecutive = keys.every((k, i) => i === 0 || k === keys[i - 1] + 1);
    if (keys.length === 1) return label(keys[0]);
    return consecutive ? `${label(keys[0])} - ${label(keys[keys.length - 1])}` : keys.map(label).join(', ');
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'X';

/**
 * TAFSD-605: the extracurricular challan files.
 *
 *   - PAID: the stamped receipt is rendered once and frozen (paid_pdf_url,
 *     first writer wins); only a reversal that takes the voucher out of PAID
 *     clears it (recomputeVoucherInTx).
 *   - Anything else: cached by a hash of exactly what the page prints, in a
 *     key that carries the hash, so a CDN never serves a stale copy and nothing
 *     has to remember to invalidate it (a payment, a sibling, another voucher
 *     or a name change all change the hash).
 */
@Injectable()
export class EcVoucherPdfService {
    private readonly logger = new Logger(EcVoucherPdfService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
        private readonly pdf: VoucherPdfService,
    ) {}

    private async load(voucherId: number) {
        return this.prisma.ec_vouchers.findUniqueOrThrow({ where: { id: voucherId }, select: PDF_SELECT });
    }

    async buildData(voucherId: number): Promise<{ data: EcVoucherPdfData; voucher: Awaited<ReturnType<EcVoucherPdfService['load']>> }> {
        const v = await this.load(voucherId);
        const today = todayPktKey();
        const state = ecVoucherState(v, today);
        const s = v.students;

        const [others, payments, siblings] = await Promise.all([
            this.prisma.ec_vouchers.findMany({
                where: { student_id: v.student_id, id: { not: v.id }, status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, reissued_to: { is: null } },
                select: { voucher_number: true, expiry_date: true, total_amount: true, amount_paid: true, amount_waived: true },
                orderBy: [{ expiry_date: 'asc' }, { id: 'asc' }],
            }),
            this.prisma.ec_deposits.findMany({
                where: { student_id: v.student_id },
                select: { deposit_date: true, amount: true, payment_method: true, ec_vouchers: { select: { voucher_number: true } } },
                orderBy: [{ deposit_date: 'desc' }, { id: 'desc' }],
                take: 3,
            }),
            s.family_id
                ? this.prisma.students.findMany({
                      where: { family_id: s.family_id, deleted_at: null, status: 'ENROLLED', cc: { not: s.cc } },
                      select: { cc: true, full_name: true, gr_number: true, classes: { select: { class_code: true, description: true } }, sections: { select: { description: true } } },
                      orderBy: { cc: 'asc' },
                  })
                : Promise.resolve([]),
        ]);

        const father =
            s.student_guardians.find((g) => isFatherRelationship(g.relationship))?.guardians?.full_name ?? s.student_guardians[0]?.guardians?.full_name ?? 'N/A';
        const bank = (v.bank_snapshot ?? {}) as unknown as Partial<EcBankSnapshot>;
        const total = Number(v.total_amount);
        const paid = Number(v.amount_paid);
        const waived = Number(v.amount_waived);

        const data: EcVoucherPdfData = {
            voucherNumber: v.voucher_number ?? String(v.id),
            student: {
                cc: s.cc,
                fullName: (s.full_name ?? '').toUpperCase(),
                fatherName: father.toUpperCase(),
                gender: (s.gender ?? 'N/A').toUpperCase(),
                grNumber: s.gr_number ?? 'N/A',
                className: challanClassLabel(v.classes),
                sectionName: (v.sections?.description ?? 'N/A').toUpperCase(),
                houseName: (s.houses?.house_color || s.houses?.house_name || 'N/A').toUpperCase(),
            },
            campusName: v.campuses?.campus_name ?? 'Main Campus',
            academicYear: v.academic_year,
            monthsLabel: ecMonthsLabel(v.ec_voucher_lines.map((l) => l.ec_student_charges.period)),
            issueDate: dateKey(v.issue_date),
            expiryDate: dateKey(v.expiry_date),
            bank: { name: bank.name ?? '', title: bank.title ?? '', account: bank.account ?? '', iban: bank.iban ?? '', address: bank.address ?? '' },
            lines: v.ec_voucher_lines.map((l) => ({ description: l.description, amount: Number(l.amount) })),
            totalAmount: total,
            amountPaid: paid,
            amountWaived: waived,
            balance: Math.max(total - paid - waived, 0),
            stamp: v.status === 'PAID' ? 'PAID' : v.status === 'WAIVED' ? 'WAIVED' : state === 'EXPIRED' || state === 'REISSUED' ? 'EXPIRED' : null,
            otherOpenVouchers: others.map((o) => ({
                voucherNumber: o.voucher_number ?? '-',
                validTill: dateKey(o.expiry_date),
                lapsed: dateKey(o.expiry_date) < today,
                balance: Math.max(Number(o.total_amount) - Number(o.amount_paid) - Number(o.amount_waived), 0),
            })),
            payments: payments.map((p) => ({
                date: dateKey(p.deposit_date),
                voucherNumber: p.ec_vouchers.voucher_number ?? '-',
                method: p.payment_method,
                amount: Number(p.amount),
            })),
            siblings: siblings.map((sib) => ({
                cc: sib.cc,
                fullName: (sib.full_name ?? '').toUpperCase(),
                grNumber: sib.gr_number ?? 'N/A',
                className: challanClassLabel(sib.classes),
                sectionName: (sib.sections?.description ?? 'N/A').toUpperCase(),
            })),
            generatedByName: v.generated_by_name ?? 'TAFSync System',
            generatedAt: v.created_at.toISOString(),
        };
        return { data, voucher: v };
    }

    hashOf(data: EcVoucherPdfData): string {
        const { qrUrl: _qr, ...rest } = data;
        return createHash('sha256').update(`${EC_PDF_TEMPLATE_VERSION}|${stableStringify(rest)}`).digest('hex');
    }

    private baseName(data: EcVoucherPdfData): string {
        return safeName(data.student.grNumber && data.student.grNumber !== 'N/A' ? data.student.grNumber : `CC${data.student.cc}`);
    }

    filenameFor(data: EcVoucherPdfData, paid: boolean): string {
        return `${this.baseName(data)}_${data.voucherNumber}${paid ? '_paid' : ''}.pdf`;
    }

    /** The challan to download: the frozen receipt for a PAID voucher, else the cached or fresh render. */
    async ensurePdf(voucherId: number): Promise<{ url: string; filename: string }> {
        const { data, voucher } = await this.buildData(voucherId);
        if (voucher.status === 'PAID') return this.ensurePaidReceipt(voucher.id, voucher.paid_pdf_url, voucher.paid_pdf_filename, data);

        const hash = this.hashOf(data);
        const filename = this.filenameFor(data, false);
        if (voucher.pdf_hash === hash && voucher.pdf_url) return { url: voucher.pdf_url, filename };

        const key = `ec-vouchers/${voucher.student_id}/${this.baseName(data)}_${data.voucherNumber}_${hash.slice(0, 8)}.pdf`;
        const buffer = await this.pdf.generateEcVoucherPdf({ ...data, qrUrl: this.storage.getPublicUrl(key) });
        const url = await this.storage.upload(key, buffer, 'application/pdf');
        await this.prisma.ec_vouchers.update({ where: { id: voucher.id }, data: { pdf_url: url, pdf_hash: hash } });
        if (voucher.pdf_url && voucher.pdf_url !== url) void this.storage.deleteByUrl(voucher.pdf_url);
        return { url, filename };
    }

    /** Render the PAID receipt once; whoever writes it first wins, and everyone after gets that file. */
    private async ensurePaidReceipt(id: number, existingUrl: string | null, existingName: string | null, data: EcVoucherPdfData) {
        const filename = this.filenameFor(data, true);
        if (existingUrl) return { url: existingUrl, filename: existingName ?? filename };
        const key = `ec-vouchers/${data.student.cc}/${this.baseName(data)}_${data.voucherNumber}_paid.pdf`;
        const buffer = await this.pdf.generateEcVoucherPdf({ ...data, stamp: 'PAID', qrUrl: this.storage.getPublicUrl(key) });
        const url = await this.storage.upload(key, buffer, 'application/pdf');
        const won = await this.prisma.ec_vouchers.updateMany({
            where: { id, paid_pdf_url: null, status: 'PAID' },
            data: { paid_pdf_url: url, paid_pdf_filename: filename, paid_pdf_generated_at: new Date() },
        });
        if (won.count === 0) {
            const fresh = await this.prisma.ec_vouchers.findUnique({ where: { id }, select: { paid_pdf_url: true, paid_pdf_filename: true } });
            if (fresh?.paid_pdf_url) return { url: fresh.paid_pdf_url, filename: fresh.paid_pdf_filename ?? filename };
        }
        return { url, filename };
    }

    /** The PDF bytes for a merge: the stored file when it is current, else a fresh render. */
    async bufferFor(voucherId: number): Promise<Buffer> {
        const { url } = await this.ensurePdf(voucherId);
        try {
            return (await this.storage.getFile(this.storage.extractKeyFromUrl(url))).buffer;
        } catch {
            // Storage not reachable (or not configured in tests): render it here.
            const { data } = await this.buildData(voucherId);
            return this.pdf.generateEcVoucherPdf(data);
        }
    }

    /** Many vouchers in one file, in the order given. */
    async merge(voucherIds: number[]): Promise<{ url: string; filename: string; count: number }> {
        const buffers: Buffer[] = [];
        for (const id of voucherIds) buffers.push(await this.bufferFor(id));
        const merged = await this.pdf.mergePdfs(buffers);
        const today = todayPktKey();
        const key = `ec-vouchers/batches/${today}-${randomUUID()}.pdf`;
        const url = await this.storage.upload(key, merged, 'application/pdf');
        this.logger.log(`Merged ${voucherIds.length} extracurricular vouchers into ${key}`);
        return { url, filename: `extracurricular-vouchers-${today}-${voucherIds.length}.pdf`, count: voucherIds.length };
    }
}
