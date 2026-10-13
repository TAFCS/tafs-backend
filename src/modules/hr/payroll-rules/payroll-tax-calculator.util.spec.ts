import { calculateStatutoryContributions } from './payroll-tax-calculator.util';

describe('calculateStatutoryContributions (TAFSD-278)', () => {
  const rules = {
    eobi: { wage_base_amount: 37_000, employee_percent: 1, employer_percent: 5 },
    sessi: { wage_base_amount: 37_000, employer_percent: 6 },
  };
  const amounts = (exempt: { eobi: boolean; sessi: boolean }) => {
    const r = calculateStatutoryContributions(rules, exempt);
    return [r.eobiDeduction.toNumber(), r.eobiEmployerCost.toNumber(), r.sessiEmployerCost.toNumber()];
  };

  it('neither exempt (the default): both schemes apply', () => {
    expect(amounts({ eobi: false, sessi: false })).toEqual([370, 1850, 2220]);
  });

  it('EOBI exempt: no EOBI deduction or employer cost, SESSI unchanged', () => {
    expect(amounts({ eobi: true, sessi: false })).toEqual([0, 0, 2220]);
  });

  it('SESSI exempt: no SESSI employer cost, EOBI unchanged', () => {
    expect(amounts({ eobi: false, sessi: true })).toEqual([370, 1850, 0]);
  });

  it('both exempt: nothing at all', () => {
    expect(amounts({ eobi: true, sessi: true })).toEqual([0, 0, 0]);
  });

  it('no rule in force: zero, exempt or not', () => {
    const r = calculateStatutoryContributions({ eobi: null, sessi: null }, { eobi: false, sessi: false });
    expect([r.eobiDeduction.toNumber(), r.eobiEmployerCost.toNumber(), r.sessiEmployerCost.toNumber()]).toEqual([0, 0, 0]);
  });
});
