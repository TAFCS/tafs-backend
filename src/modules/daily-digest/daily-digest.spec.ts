import { percentChange } from './daily-digest.service';
import { renderDailyDigestHtml } from '../../common/mailer/daily-digest-email';

/** TAFSD-371: change-vs-yesterday maths and how it is coloured. */
describe('daily digest', () => {
  it('rounds the change to a whole percent', () => {
    expect(percentChange(118, 100)).toBe(18);
    expect(percentChange(97, 100)).toBe(-3);
    expect(percentChange(5, 5)).toBe(0);
  });

  it('has no percentage when yesterday was zero', () => {
    expect(percentChange(3, 0)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
  });

  it('colours a rise green for money and red for a growing queue', () => {
    const html = renderDailyDigestHtml('s', {
      dateLabel: 'Friday',
      deposits: { value: 'Rs 10', change: 10, higherIsGood: true, sub: '1 deposit' },
      attendance: [],
      pending: [{ label: 'Open support tickets', value: '7', change: 40, higherIsGood: false }],
    });
    const pill = (text: string) => html.slice(html.lastIndexOf('<span', html.indexOf(text)), html.indexOf(text));
    expect(pill('10% vs yesterday')).toContain('#047857');
    expect(pill('40% vs yesterday')).toContain('#BE123C');
    expect(html).toContain('Open support tickets');
  });
});
