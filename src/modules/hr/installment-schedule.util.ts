import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

export function money(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2);
}

export function equalInstallmentAmount(total: Prisma.Decimal, count: number): Prisma.Decimal {
  const cents = total.times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN);
  return cents.dividedToIntegerBy(count).dividedBy(100).toDecimalPlaces(2);
}

/** Equal remaining months; last slot absorbs leftover cents so the sum equals `total`. */
export function buildEqualSchedule(total: Prisma.Decimal, count: number): number[] {
  const remainingTarget = money(total);
  if (count < 1 || remainingTarget.lte(0)) return [];
  const base = equalInstallmentAmount(remainingTarget, count);
  if (base.lte(0)) return [];
  const amounts: number[] = [];
  let left = remainingTarget;
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      amounts.push(Number(left.toFixed(2)));
    } else {
      const take = Prisma.Decimal.min(base, left).toDecimalPlaces(2);
      amounts.push(Number(take.toFixed(2)));
      left = left.minus(take);
    }
  }
  return amounts.filter((n) => n > 0);
}

export function parseInstallmentSchedule(
  raw: Prisma.JsonValue | null | undefined,
  fallbackAmount: Prisma.Decimal,
): Prisma.Decimal[] {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((value) => money(typeof value === 'number' || typeof value === 'string' ? value : 0))
      .filter((amount) => amount.gt(0));
  }
  const fallback = money(fallbackAmount);
  return fallback.gt(0) ? [fallback] : [];
}

export function nextScheduledAmount(
  raw: Prisma.JsonValue | null | undefined,
  fallbackAmount: Prisma.Decimal,
): Prisma.Decimal {
  return parseInstallmentSchedule(raw, fallbackAmount)[0] ?? ZERO;
}

export function shiftScheduleAfterCollection(
  raw: Prisma.JsonValue | null | undefined,
  fallbackAmount: Prisma.Decimal,
  collectedFullDue: boolean,
  remainingAfter: Prisma.Decimal,
): { schedule: number[]; installment_count: number; installment_amount: Prisma.Decimal } {
  let schedule = parseInstallmentSchedule(raw, fallbackAmount).map((amount) => Number(amount.toFixed(2)));
  if (remainingAfter.lte(0)) {
    return { schedule: [], installment_count: 0, installment_amount: ZERO };
  }
  if (collectedFullDue && schedule.length > 0) {
    schedule = schedule.slice(1);
  }
  if (schedule.length === 0) {
    schedule = [Number(remainingAfter.toFixed(2))];
  }
  return {
    schedule,
    installment_count: schedule.length,
    installment_amount: money(schedule[0]),
  };
}

export function scheduleJson(amounts: number[]): Prisma.InputJsonValue {
  return amounts.map((n) => Number(money(n).toFixed(2)));
}

export function scheduleAsNumbers(
  raw: Prisma.JsonValue | null | undefined,
  fallbackAmount: Prisma.Decimal,
): number[] {
  return parseInstallmentSchedule(raw, fallbackAmount).map((amount) => Number(amount.toFixed(2)));
}

export function assertScheduleMatchesRemaining(amounts: number[], remaining: Prisma.Decimal): number[] {
  if (!Array.isArray(amounts) || amounts.length < 1 || amounts.length > 120) {
    throw new BadRequestException('Enter between 1 and 120 remaining months.');
  }
  const schedule: number[] = [];
  let sum = ZERO;
  for (const raw of amounts) {
    const amount = money(raw);
    if (amount.lte(0)) {
      throw new BadRequestException('Each month must be greater than zero.');
    }
    schedule.push(Number(amount.toFixed(2)));
    sum = sum.plus(amount);
  }
  if (!sum.eq(money(remaining))) {
    throw new BadRequestException(
      `Monthly amounts must add up to the remaining balance of ${money(remaining).toFixed(2)}.`,
    );
  }
  return schedule;
}
