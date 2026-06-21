/** UTC day-of-week: 0 = Sunday, 6 = Saturday */
export function isWeekendDate(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow === 0 || dow === 6;
}

export function parseCalendarDateKey(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/**
 * Resolves how a student calendar day should appear in attendance history.
 * Weekends are off by default; explicit DB overrides take precedence.
 */
export function resolveStudentCalendarDay(
  date: Date,
  calDay: { day_type: string; description: string | null } | null,
): { holiday_type: string | null; holiday_description: string | null } {
  if (calDay) {
    if (calDay.day_type === 'WORKDAY') {
      return { holiday_type: null, holiday_description: null };
    }
    if (calDay.day_type === 'HOLIDAY') {
      return {
        holiday_type: 'HOLIDAY',
        holiday_description: calDay.description,
      };
    }
    if (calDay.day_type === 'WEEKEND') {
      return {
        holiday_type: 'WEEKEND',
        holiday_description: calDay.description ?? 'Day Off',
      };
    }
  }

  if (isWeekendDate(date)) {
    return { holiday_type: 'WEEKEND', holiday_description: 'Weekend' };
  }

  return { holiday_type: null, holiday_description: null };
}
