import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { BankAccountsService } from './bank-accounts.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';

@ApiTags('Bank Accounts')
@Controller('bank-accounts')
@UseGuards(JwtStaffGuard)
export class BankAccountsController {
    constructor(private readonly bankAccountsService: BankAccountsService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new bank account' })
    @ApiResponse({ status: 201, description: 'The bank account has been successfully created.' })
    async create(@Body() createBankAccountDto: CreateBankAccountDto) {
        const bankAccount = await this.bankAccountsService.create(createBankAccountDto);
        return createApiResponse(bankAccount, HttpStatus.CREATED, 'Bank account created successfully');
    }

    @Get()
    @ApiOperation({ summary: 'Get all bank accounts' })
    async findAll() {
        const bankAccounts = await this.bankAccountsService.findAll();
        return createApiResponse(bankAccounts, HttpStatus.OK, 'Bank accounts fetched successfully');
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a bank account by ID' })
    async findOne(@Param('id', ParseIntPipe) id: number) {
        const bankAccount = await this.bankAccountsService.findOne(id);
        return createApiResponse(bankAccount, HttpStatus.OK, 'Bank account fetched successfully');
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a bank account by ID' })
    async update(@Param('id', ParseIntPipe) id: number, @Body() updateBankAccountDto: UpdateBankAccountDto) {
        const bankAccount = await this.bankAccountsService.update(id, updateBankAccountDto);
        return createApiResponse(bankAccount, HttpStatus.OK, 'Bank account updated successfully');
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a bank account by ID' })
    async remove(@Param('id', ParseIntPipe) id: number) {
        await this.bankAccountsService.remove(id);
        return createApiResponse(null, HttpStatus.OK, 'Bank account deleted successfully');
    }
}
