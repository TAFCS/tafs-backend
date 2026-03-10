import { IsString, IsNotEmpty, IsOptional, IsEmail, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBankAccountDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    account_title: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    account_number: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    bank_name: string;

    @ApiPropertyOptional()
    @IsString()
    @IsOptional()
    @MaxLength(20)
    branch_code?: string;

    @ApiPropertyOptional()
    @IsString()
    @IsOptional()
    bank_address?: string;

    @ApiPropertyOptional()
    @IsString()
    @IsOptional()
    @MaxLength(50)
    iban?: string;
}
