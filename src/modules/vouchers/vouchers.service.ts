import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { StorageService } from '../../common/storage/storage.service';

const VOUCHER_INCLUDE = {
    students: {
        select: { cc: true, full_name: true, gr_number: true },
    },
    campuses: {
        select: { id: true, campus_name: true },
    },
    classes: {
        select: { id: true, description: true },
    },
    sections: {
        select: { id: true, description: true },
    },
    bank_accounts: {
        select: { id: true, bank_name: true, account_title: true, account_number: true, branch_code: true, bank_address: true, iban: true },
    },
};

@Injectable()
export class VouchersService {
    private readonly logger = new Logger(VouchersService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
    ) {}

    async create(dto: CreateVoucherDto, pdfBuffer?: Buffer) {
        const issueDate = new Date(dto.issue_date);
        const dueDate = new Date(dto.due_date);
        const validityDate = dto.validity_date ? new Date(dto.validity_date) : null;

        return this.prisma.$transaction(async (tx) => {
            const voucher = await tx.vouchers.create({
                data: {
                    student_id: dto.student_id,
                    campus_id: dto.campus_id,
                    class_id: dto.class_id,
                    section_id: dto.section_id,
                    bank_account_id: dto.bank_account_id,
                    issue_date: issueDate,
                    due_date: dueDate,
                    validity_date: validityDate,
                    late_fee_charge: dto.late_fee_charge,
                    academic_year: dto.academic_year,
                    month: dto.month,
                },
                include: VOUCHER_INCLUDE,
            });

            // Propagate issue_date, due_date, validity_date and precedence to the
            // student's fee records so they reflect the same billing cycle.
            if (dto.orderedFeeIds && dto.orderedFeeIds.length > 0) {
                // If specific order is provided, update them sequentially
                for (let i = 0; i < dto.orderedFeeIds.length; i++) {
                    await tx.student_fees.update({
                        where: { id: dto.orderedFeeIds[i] },
                        data: {
                            issue_date: issueDate,
                            due_date: dueDate,
                            validity_date: validityDate,
                            precedence_override: (dto.precedence ?? 0) + i,
                            status: 'ISSUED' as any,
                        },
                    });
                }
            } else {
                // Otherwise update all fees for this student with same precedence
                await tx.student_fees.updateMany({
                    where: { student_id: dto.student_id },
                    data: {
                        issue_date: issueDate,
                        due_date: dueDate,
                        validity_date: validityDate,
                        status: 'ISSUED' as any,
                        ...(dto.precedence !== undefined ? { precedence_override: dto.precedence } : {}),
                    },
                });
            }

            // If a PDF was provided, upload it to DigitalOcean Spaces.
            if (pdfBuffer) {
                const key = `vouchers/${dto.student_id}/voucher-${voucher.id}-${Date.now()}.pdf`;
                const pdfUrl = await this.storage.upload(key, pdfBuffer);

                // Update the voucher with the PDF URL
                await tx.vouchers.update({
                    where: { id: voucher.id },
                    data: { pdf_url: pdfUrl },
                });

                return { ...voucher, pdf_url: pdfUrl };
            }

            return voucher;
        });
    }

    async findAll(
        studentId?: number,
        campusId?: number,
        status?: string,
        classId?: number,
        sectionId?: number,
        cc?: number,
        gr?: string,
    ) {
        try {
            return await this.prisma.vouchers.findMany({
                where: {
                    // student_id or cc both resolve to student_id (cc is the student PK)
                    ...(cc ? { student_id: cc } : studentId ? { student_id: studentId } : {}),
                    ...(campusId ? { campus_id: campusId } : {}),
                    ...(classId ? { class_id: classId } : {}),
                    ...(sectionId ? { section_id: sectionId } : {}),
                    ...(status ? { status } : {}),
                    ...(gr
                        ? {
                              students: {
                                  gr_number: { contains: gr, mode: 'insensitive' },
                              },
                          }
                        : {}),
                },
                include: VOUCHER_INCLUDE,
                orderBy: { issue_date: 'desc' },
            });
        } catch (err: any) {
            this.logger.error('findAll failed', err?.message, err?.stack);
            throw new InternalServerErrorException(
                `Voucher query failed: ${err?.message ?? 'Unknown error'}`,
            );
        }
    }

    async findOne(id: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: VOUCHER_INCLUDE,
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher with ID ${id} not found`);
        }

        return voucher;
    }

    async update(id: number, dto: UpdateVoucherDto) {
        await this.findOne(id); // ensure it exists

        return this.prisma.vouchers.update({
            where: { id },
            data: {
                ...(dto.issue_date ? { issue_date: new Date(dto.issue_date) } : {}),
                ...(dto.due_date ? { due_date: new Date(dto.due_date) } : {}),
                ...(dto.validity_date !== undefined ? { validity_date: dto.validity_date ? new Date(dto.validity_date) : null } : {}),
                ...(dto.status !== undefined ? { status: dto.status } : {}),
                ...(dto.late_fee_charge !== undefined ? { late_fee_charge: dto.late_fee_charge } : {}),
                ...(dto.bank_account_id ? { bank_account_id: dto.bank_account_id } : {}),
                ...(dto.section_id !== undefined ? { section_id: dto.section_id } : {}),
            },
            include: VOUCHER_INCLUDE,
        });
    }
}
