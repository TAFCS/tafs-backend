import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';

const VOUCHER_INCLUDE = {
    students: {
        select: { cc: true, full_name: true, gr_number: true },
    },
    campuses: {
        select: { id: true, name: true },
    },
    classes: {
        select: { id: true, description: true },
    },
    bank_accounts: {
        select: { id: true, bank_name: true, account_title: true, account_number: true },
    },
};

@Injectable()
export class VouchersService {
    constructor(private readonly prisma: PrismaService) {}

    async create(dto: CreateVoucherDto) {
        return this.prisma.vouchers.create({
            data: {
                student_id: dto.student_id,
                campus_id: dto.campus_id,
                class_id: dto.class_id,
                bank_account_id: dto.bank_account_id,
                issue_date: new Date(dto.issue_date),
                due_date: new Date(dto.due_date),
                validity_date: dto.validity_date ? new Date(dto.validity_date) : null,
                late_fee_charge: dto.late_fee_charge,
            },
            include: VOUCHER_INCLUDE,
        });
    }

    async findAll(studentId?: number, campusId?: number, status?: string) {
        return this.prisma.vouchers.findMany({
            where: {
                ...(studentId ? { student_id: studentId } : {}),
                ...(campusId ? { campus_id: campusId } : {}),
                ...(status ? { status } : {}),
            },
            include: VOUCHER_INCLUDE,
            orderBy: { issue_date: 'desc' },
        });
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
            },
            include: VOUCHER_INCLUDE,
        });
    }
}
