import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { ChatGateway } from '../chat/chat.gateway';
import {
  VoucherNotificationService,
  VOUCHER_ALERT_TYPES,
  addPktDays,
  dateFromPktKey,
  pktDateKey,
} from './voucher-notification.service';

describe('voucher notification date utils', () => {
  it('pktDateKey returns Asia/Karachi calendar date', () => {
    // 2026-07-01 20:00 UTC = 2026-07-02 01:00 PKT
    expect(pktDateKey(new Date('2026-07-01T20:00:00.000Z'))).toBe('2026-07-02');
    expect(pktDateKey(new Date('2026-07-01T10:00:00.000Z'))).toBe('2026-07-01');
  });

  it('addPktDays adds calendar days on PKT keys', () => {
    expect(addPktDays('2026-07-01', 3)).toBe('2026-07-04');
    expect(addPktDays('2026-07-01', 1)).toBe('2026-07-02');
  });

  it('dateFromPktKey round-trips with addPktDays for due matching', () => {
    const todayKey = '2026-07-01';
    const dueKey = addPktDays(todayKey, 3);
    expect(dateFromPktKey(dueKey).toISOString().slice(0, 10)).toBe('2026-07-04');
  });
});

describe('VoucherNotificationService', () => {
  let service: VoucherNotificationService;
  let prisma: {
    voucher_notifications: {
      findUnique: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
    vouchers: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };
  let fcm: { sendToFamily: jest.Mock };
  let chatGateway: { broadcastVoucherAlert: jest.Mock };

  const sampleVoucher = {
    id: 100,
    student_id: 12345,
    due_date: dateFromPktKey('2026-07-04'),
    validity_date: dateFromPktKey('2026-07-10'),
    month: 7,
    status: 'UNPAID',
    students: {
      full_name: 'Ali Khan',
      family_id: 42,
      cc: 12345,
    },
  };

  beforeEach(async () => {
    prisma = {
      voucher_notifications: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      vouchers: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    fcm = { sendToFamily: jest.fn().mockResolvedValue(undefined) };
    chatGateway = { broadcastVoucherAlert: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoucherNotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: FcmService, useValue: fcm },
        { provide: ChatGateway, useValue: chatGateway },
      ],
    }).compile();

    service = module.get(VoucherNotificationService);
  });

  it('sendApproachingDueReminders queries UNPAID vouchers due in 3/2/1 days', async () => {
    prisma.vouchers.findMany.mockResolvedValue([sampleVoucher]);

    await service.sendApproachingDueReminders(dateFromPktKey('2026-07-01'));

    expect(prisma.vouchers.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.vouchers.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'UNPAID',
          due_date: dateFromPktKey('2026-07-04'),
        }),
      }),
    );
    expect(fcm.sendToFamily).toHaveBeenCalledTimes(3);
  });

  it('notifyVoucher is idempotent when alert already exists', async () => {
    prisma.voucher_notifications.findUnique.mockResolvedValue({ id: 99 });

    await service.notifyVoucher(
      42,
      12345,
      100,
      VOUCHER_ALERT_TYPES.DUE_REMINDER_3D,
      'Title',
      'Body',
    );

    expect(prisma.voucher_notifications.create).not.toHaveBeenCalled();
    expect(fcm.sendToFamily).not.toHaveBeenCalled();
  });

  it('sendBecameOverdueForVoucherIds sends BECAME_OVERDUE only for overdue vouchers with family', async () => {
    prisma.vouchers.findMany.mockResolvedValue([
      { ...sampleVoucher, status: 'OVERDUE' },
    ]);

    const sent = await service.sendBecameOverdueForVoucherIds([100]);

    expect(sent).toBe(1);
    expect(prisma.voucher_notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          alert_type: VOUCHER_ALERT_TYPES.BECAME_OVERDUE,
          family_id: 42,
          voucher_id: 100,
        }),
      }),
    );
    expect(fcm.sendToFamily).toHaveBeenCalledWith(
      42,
      expect.any(String),
      expect.stringContaining('overdue'),
      expect.objectContaining({ type: 'voucher_alert', voucher_id: '100' }),
    );
  });

  it('sendApproachingExpiryReminders targets OVERDUE vouchers expiring in 3 days', async () => {
    prisma.vouchers.findMany.mockResolvedValue([
      { ...sampleVoucher, status: 'OVERDUE', validity_date: dateFromPktKey('2026-07-04') },
    ]);

    await service.sendApproachingExpiryReminders(dateFromPktKey('2026-07-01'));

    expect(prisma.vouchers.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'OVERDUE',
          validity_date: dateFromPktKey('2026-07-04'),
        }),
      }),
    );
    expect(fcm.sendToFamily).toHaveBeenCalledWith(
      42,
      expect.any(String),
      expect.stringContaining('going to expire'),
      expect.any(Object),
    );
  });

  it('sendVoucherIssuedNotification notifies family when voucher is created', async () => {
    prisma.vouchers.findUnique.mockResolvedValue({
      id: 100,
      student_id: 12345,
      due_date: dateFromPktKey('2026-07-10'),
      month: 7,
      status: 'UNPAID',
      students: { full_name: 'Ali Khan', family_id: 42, deleted_at: null },
    });

    await service.sendVoucherIssuedNotification(100);

    expect(prisma.voucher_notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          alert_type: VOUCHER_ALERT_TYPES.VOUCHER_ISSUED,
          family_id: 42,
          voucher_id: 100,
        }),
      }),
    );
    expect(fcm.sendToFamily).toHaveBeenCalledWith(
      42,
      expect.stringContaining('New Fee Challan'),
      expect.stringContaining('challan'),
      expect.objectContaining({ alert_type: VOUCHER_ALERT_TYPES.VOUCHER_ISSUED }),
    );
  });

  it('sendVoucherIssuedNotification skips vouchers without family', async () => {
    prisma.vouchers.findUnique.mockResolvedValue({
      id: 100,
      student_id: 12345,
      due_date: dateFromPktKey('2026-07-10'),
      month: 7,
      status: 'UNPAID',
      students: { full_name: 'No Family', family_id: null, deleted_at: null },
    });

    const result = await service.sendVoucherIssuedNotification(100);
    expect(result).toBeNull();
    expect(fcm.sendToFamily).not.toHaveBeenCalled();
  });
});
