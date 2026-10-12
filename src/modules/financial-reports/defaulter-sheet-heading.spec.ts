import { campusLine, defaulterFilterLines, defaulterSheetHeading, sessionLine } from './defaulter-sheet-heading';

const VIII = { class_id: 17, class_name: 'VIII' };
const IX = { class_id: 18, class_name: 'IX' };
const AS = { class_id: 20, class_name: 'AS Level' };
const A2 = { class_id: 21, class_name: 'A2 Level' };

describe('defaulterSheetHeading (TAFSD-289)', () => {
  it('whole school (no class or segment filter) gets the plain name, whatever classes are on the sheet', () => {
    const h = defaulterSheetHeading([VIII, AS], false, '2026-10-12');
    expect(h.school).toBe('THE AMERICAN FOUNDATION SCHOOL');
    expect(h.classesLine).toBeNull();
  });

  it('classes 6–10 only → Secondary Studies', () => {
    const h = defaulterSheetHeading([VIII, IX, VIII], true, '2026-10-12');
    expect(h.school).toBe('THE AMERICAN FOUNDATION SCHOOL FOR SECONDARY STUDIES');
    expect(h.classesLine).toBeNull();
  });

  it('A Level only → A Level Studies', () => {
    const h = defaulterSheetHeading([AS, A2], true, '2026-10-12');
    expect(h.school).toBe('THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES');
    expect(h.classesLine).toBeNull();
  });

  it('a mix of both groups → plain name plus a classes line in class order', () => {
    const h = defaulterSheetHeading([A2, VIII, AS], true, '2026-10-12');
    expect(h.school).toBe('THE AMERICAN FOUNDATION SCHOOL');
    expect(h.classesLine).toBe('CLASSES: VIII, AS LEVEL, A2 LEVEL');
  });

  it('session follows the Aug–Jul year, or Apr–Mar on a Secondary-only sheet', () => {
    expect(defaulterSheetHeading([AS], true, '2026-10-12').session).toBe('SESSION 2026–2027');
    expect(defaulterSheetHeading([AS], true, '2026-05-01').session).toBe('SESSION 2025–2026');
    expect(defaulterSheetHeading([VIII], true, '2026-05-01').session).toBe('SESSION 2026–2027');
    expect(sessionLine('2027-07-31')).toBe('SESSION 2026–2027');
  });

  it('campus line is the full name, not a bracketed code', () => {
    expect(campusLine('Gulistan-e-Jauhar')).toBe('GULISTAN-E-JAUHAR CAMPUS');
    expect(campusLine('North Nazimabad Campus')).toBe('NORTH NAZIMABAD CAMPUS');
  });
});

describe('defaulterFilterLines (TAFSD-291)', () => {
  const names = {
    campuses: new Map([[3, 'North Nazimabad']]),
    classes: new Map([[15, 'VI'], [16, 'VII'], [17, 'VIII'], [18, 'IX']]),
    sections: new Map([[4, 'A']]),
    segments: new Map([[2, 'Secondary School']]),
  };

  it("the page's defaults (enrolled only, nothing else) → ALL STUDENTS", () => {
    expect(defaulterFilterLines({ student_status: ['ENROLLED'] }, names, null)).toEqual(['ALL STUDENTS']);
  });

  it('status cleared → says every status is included', () => {
    expect(defaulterFilterLines({}, names, null)).toEqual(['ALL STUDENT STATUSES']);
  });

  it('campus + classes 6–9 + Left → one line each, by name', () => {
    expect(
      defaulterFilterLines({ campus_id: [3], class_id: [15, 16, 17, 18], student_status: ['LEFT'] }, names, null),
    ).toEqual(['CAMPUS: NORTH NAZIMABAD', 'CLASSES: VI, VII, VIII, IX', 'LEFT STUDENTS ONLY']);
  });

  it('months line first, then segment, section, several statuses, severity', () => {
    expect(
      defaulterFilterLines(
        { segment_id: [2], section_id: [4], student_status: ['LEFT', 'EXPELLED'], severity: ['CRITICAL'] },
        names,
        '4 & 5 MONTHS DEFAULTERS',
      ),
    ).toEqual([
      '4 & 5 MONTHS DEFAULTERS',
      'SEGMENT: SECONDARY SCHOOL',
      'SECTION: A',
      'LEFT & EXPELLED STUDENTS ONLY',
      'SEVERITY: CRITICAL',
    ]);
  });

  it('does not repeat the classes when the title block already names them', () => {
    expect(defaulterFilterLines({ class_id: [17], student_status: ['ENROLLED'] }, names, null, true)).toEqual([]);
  });
});
