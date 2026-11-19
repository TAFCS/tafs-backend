import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UblBillPaymentDto, normalizeUblDatetime, ublBlankToUndefined } from './ubl-bill.dto';

/** The HTTP app's ValidationPipe runs with transform + whitelist; mirror the transform step. */
async function check(body: Record<string, unknown>) {
    const dto = plainToInstance(UblBillPaymentDto, body);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return { dto, errors: errors.flatMap((e) => Object.values(e.constraints ?? {})) };
}

// The two requests from UBL's 18 Nov 2026 logs (test CC 44), verbatim.
const ublLog = (payment_method: string) => ({
    consumer_number: '100000000000044',
    amount: '15053',
    payment_method,
    transaction_id: '844826161',
    transaction_datetime: '20261118',
    voucher_number: '12260014422',
    payer_bank_code: '{}',
    payer_bank_name: '{}',
    instrument_number: '{}',
});

describe('UblBillPaymentDto (TAFSD-538)', () => {
    it.each(['ONEBILL', ''])('accepts UBL\'s 1Bill request with payment_method %j', async (method) => {
        const { dto, errors } = await check(ublLog(method));
        expect(errors).toEqual([]);
        expect(dto.payment_method).toBe(method === '' ? undefined : 'ONEBILL');
        expect(dto.transaction_datetime).toBe('2026-11-18T00:00:00+05:00');
        expect(dto.payer_bank_code).toBeUndefined();
        expect(dto.payer_bank_name).toBeUndefined();
        expect(dto.instrument_number).toBeUndefined();
        expect(dto.amount).toBe(15053);
    });

    it('accepts a null payment_method', async () => {
        const { dto, errors } = await check({ ...ublLog('x'), payment_method: null });
        expect(errors).toEqual([]);
        expect(dto.payment_method).toBeUndefined();
    });

    it('still rejects an unknown payment_method', async () => {
        const { errors } = await check(ublLog('BITCOIN'));
        expect(errors.join()).toContain('payment_method must be one of');
    });

    it('accepts the documented ISO form and the compact forms, rejects bad dates', async () => {
        expect((await check({ ...ublLog('ONEBILL'), transaction_datetime: '2026-10-12T10:15:00+05:00' })).errors).toEqual([]);
        expect((await check({ ...ublLog('ONEBILL'), transaction_datetime: '20261118143005' })).dto.transaction_datetime).toBe(
            '2026-11-18T14:30:05+05:00',
        );
        expect((await check({ ...ublLog('ONEBILL'), transaction_datetime: '20261340' })).errors.join()).toContain(
            'transaction_datetime',
        );
        expect((await check({ ...ublLog('ONEBILL'), transaction_datetime: '18/11/2026' })).errors.join()).toContain(
            'transaction_datetime',
        );
    });

    it('keeps real values in the optional text fields', async () => {
        const { dto } = await check({ ...ublLog('ONEBILL'), payer_bank_code: ' MCB ', instrument_number: '000123' });
        expect(dto.payer_bank_code).toBe('MCB');
        expect(dto.instrument_number).toBe('000123');
    });
});

describe('UBL field helpers', () => {
    it('blank markers become undefined', () => {
        for (const v of ['', '  ', '{}', 'null', 'NULL', null, undefined]) expect(ublBlankToUndefined(v)).toBeUndefined();
        expect(ublBlankToUndefined('0')).toBe('0');
    });
    it('compact dates are Pakistan time', () => {
        expect(normalizeUblDatetime('20261118')).toBe('2026-11-18T00:00:00+05:00');
        expect(normalizeUblDatetime('202611181430')).toBe('2026-11-18T14:30:00+05:00');
        expect(normalizeUblDatetime('2026-11-18T09:00:00Z')).toBe('2026-11-18T09:00:00Z');
    });
});
