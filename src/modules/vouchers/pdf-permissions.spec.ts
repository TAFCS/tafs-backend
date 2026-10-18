import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { VouchersController } from './vouchers.controller';
import { TILES_MANIFEST } from '../access/tiles.manifest';

describe('voucher PDF permissions (TAFSD-310)', () => {
  const service = {
    assertVoucherVisible: jest.fn().mockResolvedValue(undefined),
    resolveGeneratedByName: jest.fn().mockResolvedValue('Tester'),
    generatePdf: jest.fn().mockResolvedValue({ pdf_url: 'x' }),
  };
  const controller = new VouchersController(service as any, {} as any);
  const staff = (actions: string[]) =>
    ({ sub: 'u1', username: 'u', role: StaffRole.EMPLOYEE, userType: 'STAFF', actions }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('declares download and regenerate on the Vouchers tile, regenerate implying download', () => {
    const actions = TILES_MANIFEST.find((t) => t.id === 'finance.vouchers')!.actions!;
    expect(actions.find((a) => a.id === 'download')?.implies).toEqual(['view']);
    expect(actions.find((a) => a.id === 'regenerate')?.implies).toEqual(['download']);
  });

  it('lets a download-only user download', async () => {
    await controller.generatePdf(1, { regenerate: false } as any, { user: {} }, staff(['finance.vouchers#download']));
    expect(service.generatePdf).toHaveBeenCalled();
  });

  it('refuses regenerate to a download-only user', async () => {
    await expect(
      controller.generatePdf(1, { regenerate: true } as any, { user: {} }, staff(['finance.vouchers#download'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.generatePdf).not.toHaveBeenCalled();
  });

  it('lets a regenerate holder regenerate', async () => {
    await controller.generatePdf(1, { regenerate: true } as any, { user: {} }, staff(['finance.vouchers#regenerate']));
    expect(service.generatePdf).toHaveBeenCalledWith(1, true, false, 'Tester', expect.objectContaining({ force: true }));
  });

  it('still scope-checks the voucher before generating', async () => {
    service.assertVoucherVisible.mockRejectedValueOnce(new Error('404'));
    await expect(
      controller.generatePdf(1, {} as any, { user: {} }, staff(['finance.vouchers#download'])),
    ).rejects.toThrow('404');
    expect(service.generatePdf).not.toHaveBeenCalled();
  });
});
