import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';

@Injectable()
export class BankAccountsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
    ) { }

    async create(createBankAccountDto: CreateBankAccountDto, changedBy?: string) {
        try {
            const record = await this.prisma.$transaction(async (tx) => {
                if (createBankAccountDto.is_default) {
                    await tx.bank_accounts.updateMany({
                        data: { is_default: false },
                    });
                }
                return await tx.bank_accounts.create({
                    data: createBankAccountDto,
                });
            });
            this.auditLogs.log({ entity_type: 'BANK', entity_id: String(record.id), action: 'CREATED', section: 'school-setup', new_value: record.account_title, changed_by: changedBy ?? 'system' });
            return record;
        } catch (error) {
            if (error.code === 'P2002') {
                throw new ConflictException('Account number or IBAN already exists');
            }
            throw error;
        }
    }

    async findAll() {
        return await this.prisma.bank_accounts.findMany({
            orderBy: [{ is_default: 'desc' }, { account_title: 'asc' }],
        });
    }

    async findOne(id: number) {
        const bankAccount = await this.prisma.bank_accounts.findUnique({
            where: { id },
        });
        if (!bankAccount) {
            throw new NotFoundException(`Bank account with ID ${id} not found`);
        }
        return bankAccount;
    }

    async update(id: number, updateBankAccountDto: UpdateBankAccountDto, changedBy?: string) {
        try {
            const record = await this.prisma.$transaction(async (tx) => {
                if (updateBankAccountDto.is_default) {
                    await tx.bank_accounts.updateMany({
                        where: { id: { not: id } },
                        data: { is_default: false },
                    });
                }
                return await tx.bank_accounts.update({
                    where: { id },
                    data: updateBankAccountDto,
                });
            });
            this.auditLogs.log({ entity_type: 'BANK', entity_id: String(id), action: 'UPDATED', section: 'school-setup', changed_by: changedBy ?? 'system' });
            return record;
        } catch (error) {
            if (error.code === 'P2025') {
                throw new NotFoundException(`Bank account with ID ${id} not found`);
            }
            if (error.code === 'P2002') {
                throw new ConflictException('Account number or IBAN already exists');
            }
            throw error;
        }
    }

    async getDependencies(id: number) {
        const vouchers = await this.prisma.vouchers.count({ where: { bank_account_id: id } });
        return { vouchers };
    }

    async remove(id: number, changedBy?: string) {
        try {
            const existing = await this.findOne(id);
            const record = await this.prisma.bank_accounts.delete({
                where: { id },
            });
            this.auditLogs.log({ entity_type: 'BANK', entity_id: String(id), action: 'DELETED', section: 'school-setup', old_value: existing.account_title, changed_by: changedBy ?? 'system' });
            return record;
        } catch (error) {
            if (error.code === 'P2025') {
                throw new NotFoundException(`Bank account with ID ${id} not found`);
            }
            throw error;
        }
    }
}
