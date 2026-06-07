jest.mock('../vouchers/vouchers.service', () => ({
  VouchersService: class MockVouchersService {},
}));

import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { FeesService } from './fees.service';

describe('FeesService.getFeeSummaryForParent', () => {
  let service: FeesService;
  let prisma: {
    students: { findFirst: jest.Mock };
    student_fees: { aggregate: jest.Mock };
  };
  let vouchersService: { findByStudentCC: jest.Mock };

  beforeEach(async () => {
    prisma = {
      students: {
        findFirst: jest.fn().mockResolvedValue({
          cc: 12345,
          family_id: 1,
          academic_year: '2025-26',
        }),
      },
      student_fees: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 21000 } }),
      },
    };

    vouchersService = {
      findByStudentCC: jest.fn().mockResolvedValue([
        {
          id: 4983,
          status: 'UNPAID',
          total_balance: '21000.00',
          total_deposited: '0.00',
          surcharge_balance: '1000.00',
          head_balance: '20000.00',
        },
      ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeesService,
        { provide: PrismaService, useValue: prisma },
        { provide: VouchersService, useValue: vouchersService },
      ],
    }).compile();

    service = module.get(FeesService);
  });

  it('includes arrear surcharge in outstanding balance', async () => {
    const result = await service.getFeeSummaryForParent(12345, 1);

    expect(vouchersService.findByStudentCC).toHaveBeenCalledWith(12345, 1);
    expect(result.outstandingBalance).toBe(21000);
    expect(result.totalPaid).toBe(0);
    expect(result.totalCharged).toBe(21000);
  });

  it('excludes PAID and VOID vouchers from outstanding', async () => {
    vouchersService.findByStudentCC.mockResolvedValue([
      {
        id: 1,
        status: 'UNPAID',
        total_balance: '21000.00',
        total_deposited: '0.00',
      },
      {
        id: 2,
        status: 'PAID',
        total_balance: '0.00',
        total_deposited: '21000.00',
      },
      {
        id: 3,
        status: 'VOID',
        total_balance: '5000.00',
        total_deposited: '0.00',
      },
    ]);

    const result = await service.getFeeSummaryForParent(12345, 1);

    expect(result.outstandingBalance).toBe(21000);
    expect(result.totalPaid).toBe(21000);
  });

  it('throws when student not linked to family', async () => {
    prisma.students.findFirst.mockResolvedValue(null);

    await expect(service.getFeeSummaryForParent(12345, 99)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
