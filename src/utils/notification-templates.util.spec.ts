import { clearTemplateCache, clause, renderNotification, resolveTemplate } from './notification-templates.util';

// TAFSD-514: renderNotification, the switch, and blank templates.
describe('notification templates (TAFSD-514)', () => {
  const prisma = (rows: Record<string, string>) =>
    ({ app_config: { findUnique: jest.fn(async ({ where }: any) => (where.key in rows ? { value: rows[where.key] } : null)) } }) as any;
  beforeEach(() => clearTemplateCache());

  it('uses the saved text, filling variables', async () => {
    const text = await renderNotification(
      prisma({ notif_staff_payroll_settled_body: 'Paid for {period}.' }),
      'notif_staff_payroll_settled',
      { title: 'Salary settled', body: 'default' },
      { period: 'Oct' },
    );
    expect(text).toEqual({ title: 'Salary settled', body: 'Paid for Oct.' });
  });

  it('sends nothing when switched off', async () => {
    const text = await renderNotification(prisma({ notif_x_disabled: 'true' }), 'notif_x', { title: 't', body: 'b' });
    expect(text).toBeNull();
  });

  it('falls back to the default when a template was saved blank', async () => {
    expect(await resolveTemplate(prisma({ notif_y_body: '   ' }), 'notif_y_body', 'Default {a}', { a: '1' })).toBe('Default 1');
  });

  it('clause() is empty without text', () => {
    expect(clause('Reason', '  ')).toBe('');
    expect(clause('Reason', 'late bus')).toBe(' Reason: late bus');
  });
});
