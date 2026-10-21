import { AttendancePolicyResolverService, scheduleCoversDate } from './attendance-policy-resolver.service';
import { ClassTimingNotificationService } from './class-timing-notification.service';
import { clearTemplateCache } from '../../utils/notification-templates.util';

// TAFSD-385: temporary timings (exam week) apply only inside their window, and
// the normal row before them takes over again the day after.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

const normal = { class_id: 1, campus_id: 2, expected_check_in: T('07:30'), end_time: T('13:30'), effective_from: D('2026-08-01'), effective_to: null };
const exams = { class_id: 1, campus_id: 2, expected_check_in: T('08:30'), end_time: T('11:30'), effective_from: D('2026-10-20'), effective_to: D('2026-10-26') };

describe('temporary school timings', () => {
  const resolver = Object.create(AttendancePolicyResolverService.prototype) as AttendancePolicyResolverService;
  const at = (iso: string, hour = 5) => resolver.resolveStudentCheckInPolicyFromCache(
    1, 2, new Date(`${iso}T0${hour}:00:00Z`), [exams, normal] as any, [],
  ).expectedCheckIn?.toISOString().slice(11, 16);

  it('uses the exam timings inside the window, including its last day at any hour', () => {
    expect(at('2026-10-20')).toBe('08:30');
    expect(at('2026-10-26', 9)).toBe('08:30');
  });

  it('falls back to the normal timings before and after the window', () => {
    expect(at('2026-10-19')).toBe('07:30');
    expect(at('2026-10-27')).toBe('07:30');
  });

  it('treats a row with no end date as open-ended', () => {
    expect(scheduleCoversDate(normal, D('2030-01-01'))).toBe(true);
  });
});

describe('timing announcement for temporary timings', () => {
  beforeEach(() => clearTemplateCache());
  const build = (custom: string | null) => {
    const svc = new ClassTimingNotificationService(
      { app_config: { findUnique: jest.fn(async ({ where }: any) => (where.key === 'notif_class_timings_body' && custom ? { value: custom } : null)) } } as any,
      {} as any,
    );
    return svc.buildMessage({
      className: 'Class IX', campusName: 'GEJ', startTime: T('08:30'), endTime: T('11:30'),
      effectiveFrom: D('2026-10-20'), effectiveTo: D('2026-10-26'),
    });
  };

  it('states the window and that normal timings resume', async () => {
    const { body } = await build(null);
    expect(body).toContain('from 20 October 2026 to 26 October 2026');
    expect(body).toContain('Normal timings resume');
  });

  it('adds the end date when an edited template leaves it out', async () => {
    const { body } = await build('{class_name} runs {start_time}–{end_time} from {effective_from}.');
    expect(body).toContain('until 26 October 2026');
  });
});
