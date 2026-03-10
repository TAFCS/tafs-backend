import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';

@Injectable()
export class BankAccountsService {
    constructor(private readonly prisma: PrismaService) { }

    async create(createBankAccountDto: CreateBankAccountDto) {
        try {
            return await this.prisma.bank_accounts.create({
                data: createBankAccountDto,
            });
        } catch (error) {
            if (error.code === 'P2002') {
                throw new ConflictException('Account number or IBAN already exists');
            }
            throw error;
        }
    }

    async findAll() {
        return await this.prisma.bank_accounts.findMany({
            orderBy: { account_title: 'asc' },
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

    async update(id: number, updateBankAccountDto: UpdateBankAccountDto) {
        try {
            const bankAccount = await this.prisma.bank_accounts.update({
                where: { id },
                data: updateBankAccountDto,
            });
            return bankAccount;
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

    async remove(id: number) {
        try {
            return await this.prisma.bank_accounts.delete({
                where: { id },
            });
        } catch (error) {
            if (error.code === 'P2025') {
                throw new NotFoundException(`Bank account with ID ${id} not found`);
            }
            throw error;
        }
    }
}
