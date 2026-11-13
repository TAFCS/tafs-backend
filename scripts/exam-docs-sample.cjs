// Sample A4 admit card, statements of marks and statement of entry (item 56). Standalone: renders
// filled PDFs from made-up data. Laid out like the school's own sheets, set in
// Times like the School Leaving Certificate.
// Usage (from tafs-backend/): node scripts/exam-docs-sample.cjs <outDir>
const path = require('path');
const fs = require('fs');
const React = require('react');
const { Document, Page, View, Text, Image, StyleSheet, Svg, Path, Font, renderToFile } = require('@react-pdf/renderer');

// Never hyphenate ("OB-TAINED").
Font.registerHyphenationCallback((word) => [word]);

const h = React.createElement;
const OUT = process.argv[2] || path.join(process.cwd(), 'exam-docs-samples');
const LOGOS = path.join(process.cwd(), 'logos');
const LOGO = {
  sec: path.join(LOGOS, 'Logo The American Foundation Sec School (2).png'),
  alevel: path.join(LOGOS, 'A-Level Logo.png'),
  /** The American Foundation "Each One Teach One" mark with the US flag. */
  motto: path.join(LOGOS, 'Logo-Each-One-Teach-One.png'),
  /** Lifted from the TAFSAL leaving-certificate blank (slc-formats/slc-tafsal-*.pdf, top right). */
  cambridge: path.join(LOGOS, 'Cambridge International Education.png'),
};

/**
 * `classes.id` 15–19: VI, VII, VIII, IX, X (Secondary). Same set as CLASS_BAND_IDS.VI_X in
 * src/common/class-band-ids.ts, and the split the leaving certificate uses for TAFSS vs TAFSAL.
 */
const VI_X_CLASS_IDS = new Set([15, 16, 17, 18, 19]);

/** Top-right logo (item 64): VI–X keep the American Foundation mark; every other class gets Cambridge International. */
function topRightLogo(classId) {
  if (!Number.isInteger(classId)) throw new Error(`classId is required to pick the top-right logo, got ${classId}`);
  return VI_X_CLASS_IDS.has(classId)
    ? { src: LOGO.motto, style: s.logoR }
    : { src: LOGO.cambridge, style: s.logoCambridge };
}

const F = { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' };
const INK = '#111111';
const MUTED = '#444444';
const RULE = '#111111';
const SHADE = '#f2f2f2';
const FAIL = '#a11d1d';

const s = StyleSheet.create({
  page: { padding: 18, fontFamily: F.r, fontSize: 10, color: INK },
  frame: { flex: 1, borderWidth: 1.2, borderColor: RULE, paddingTop: 10, paddingHorizontal: 16, paddingBottom: 8 },
  // Header
  logos: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  logoL: { width: 52, height: 50 },
  logoR: { width: 100, height: 29, marginTop: 4 },
  // 400 x 91 artwork; about the size the school's own SOE prints it.
  logoCambridge: { width: 118, height: 26.9, marginTop: 5 },
  school: { fontFamily: F.b, fontSize: 18, textAlign: 'center', letterSpacing: 0.3, marginTop: 4 },
  titleLine: { fontFamily: F.b, fontSize: 11.5, textAlign: 'center', marginTop: 1.5 },
  docTitle: { fontFamily: F.b, fontSize: 14, textAlign: 'center', marginTop: 4, letterSpacing: 2 },
  // Fields
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { fontFamily: F.b, fontSize: 9.5, letterSpacing: 0.3 },
  box: { borderWidth: 0.9, borderColor: RULE, paddingVertical: 3.5, paddingHorizontal: 6, justifyContent: 'center' },
  boxText: { fontFamily: F.b, fontSize: 10.5 },
  photo: { width: 82, height: 98, borderWidth: 1, borderColor: RULE, alignItems: 'center', justifyContent: 'center', backgroundColor: SHADE },
  photoInitials: { fontFamily: F.b, fontSize: 28, color: '#9a9a9a' },
  photoNote: { fontSize: 6.5, color: '#888888', marginTop: 3, letterSpacing: 0.5 },
  // Tables
  table: { borderWidth: 0.9, borderColor: RULE },
  thRow: { flexDirection: 'row', backgroundColor: SHADE, borderBottomWidth: 0.9, borderBottomColor: RULE },
  th: { fontFamily: F.b, fontSize: 8.5, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 3, letterSpacing: 0.2 },
  tr: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#9a9a9a' },
  td: { fontSize: 10, paddingVertical: 3.1, paddingHorizontal: 5, textAlign: 'center' },
  vline: { borderLeftWidth: 0.5, borderLeftColor: '#9a9a9a' },
  // Signatures / footer
  signBox: { borderWidth: 0.9, borderColor: RULE, flexDirection: 'row', paddingTop: 30, paddingBottom: 8, paddingHorizontal: 6 },
  sign: { flex: 1, alignItems: 'center', marginHorizontal: 14 },
  signLine: { alignSelf: 'stretch', borderTopWidth: 0.8, borderTopColor: RULE, marginBottom: 3 },
  signLabel: { fontFamily: F.b, fontSize: 8.5, textAlign: 'center', letterSpacing: 0.3 },
  footerBox: { borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, alignItems: 'center' },
  footCampus: { fontFamily: F.b, fontSize: 9, letterSpacing: 0.4 },
  footText: { fontSize: 7.5, marginTop: 1.5, textAlign: 'center', color: MUTED },
  sysNote: { fontFamily: F.i, fontSize: 7.5, textAlign: 'center', marginTop: 3, color: MUTED },
});

const FOOT = {
  address: 'C-61, 62, 63, 64 & 65, Block 13, Gulistan-e-Jauhar, Karachi  ·  Phone (92-21) 3476-5111-13  ·  Fax (92-21) 3476-5114',
  web: 'info@tafs.edu.pk  ·  american@cyber.net.pk  ·  www.tafs.edu.pk',
};

// ---------- shared pieces ----------

function Header({ logo, classId, school, lines, title }) {
  const right = topRightLogo(classId);
  return h(View, null,
    h(View, { style: s.logos },
      h(Image, { src: logo, style: s.logoL }),
      h(Image, { src: right.src, style: right.style }),
    ),
    h(Text, { style: [s.school, school.length > 44 ? { fontSize: 15.5 } : null] }, school),
    title ? h(Text, { style: s.docTitle }, title) : null,
    lines.map((l) => h(Text, { key: l, style: s.titleLine }, l)),
  );
}

/** "LABEL :  [ value ]" with fixed label and box widths. */
function Field({ label, value, labelW = 116, boxW, flex, center, mt = 5 }) {
  return h(View, { style: [s.row, { marginTop: mt }, flex ? { flex } : null] },
    h(Text, { style: [s.label, { width: labelW }] }, `${label} :`),
    h(View, { style: [s.box, boxW ? { width: boxW } : { flex: 1 }] },
      h(Text, { style: [s.boxText, center ? { textAlign: 'center' } : null] }, value),
    ),
  );
}

function Photo({ initials }) {
  return h(View, { style: s.photo },
    h(Text, { style: s.photoInitials }, initials),
    h(Text, { style: s.photoNote }, 'PHOTOGRAPH'),
  );
}

function Signatures({ rows }) {
  return h(View, { style: [s.signBox, { flexDirection: 'column', paddingTop: 0 }] },
    rows.map((labels, i) => h(View, { key: i, style: { flexDirection: 'row', marginTop: 26 } },
      labels.map((l) => h(View, { key: l, style: s.sign }, h(View, { style: s.signLine }), h(Text, { style: s.signLabel }, l))),
    )),
  );
}

function Footer({ campus, issued, right }) {
  return h(View, { style: { marginTop: 6 } },
    issued
      ? h(View, { style: [s.row, { borderWidth: 0.9, borderColor: RULE, paddingVertical: 3.5, paddingHorizontal: 8, marginBottom: 5 }] },
          h(Text, { style: { fontFamily: F.bi, fontSize: 8.5 } }, issued),
          right ? h(Text, { style: { fontFamily: F.bi, fontSize: 8.5, marginLeft: 'auto' } }, right) : null,
        )
      : null,
    h(View, { style: s.footerBox },
      h(Text, { style: s.footCampus }, campus),
      h(Text, { style: s.footText }, FOOT.address),
      h(Text, { style: s.footText }, FOOT.web),
    ),
    h(Text, { style: s.sysNote }, 'This is a system generated document issued without alteration or erasure, and does not require a signature.'),
  );
}

function Tick({ on }) {
  return h(View, { style: { width: 11, height: 11, borderWidth: 0.9, borderColor: RULE, marginLeft: 6, alignItems: 'center', justifyContent: 'center' } },
    on ? h(Svg, { width: 9, height: 9, viewBox: '0 0 10 10' }, h(Path, { d: 'M1.5 5.2 L4 7.8 L8.8 2', stroke: INK, strokeWidth: 1.6, fill: 'none' })) : null,
  );
}

const pct = (n, d) => (d ? (n * 100) / d : 0);
const two = (n) => String(n).padStart(2, '0');
const WORDS = ['NIL', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE'];

// ---------- 1. Admit card ----------

function AdmitCard(d) {
  const W = { subject: null, date: 150, time: 150 };
  const cs = (k) => (W[k] ? { width: W[k] } : { flex: 1 });
  return h(Page, { size: 'A4', style: s.page },
    h(View, { style: s.frame },
      h(Header, { classId: d.classId, logo: LOGO.sec, school: 'THE AMERICAN FOUNDATION SECONDARY SCHOOL', title: 'ADMIT CARD', lines: [d.assessment.toUpperCase(), `SESSION ${d.session}`] }),
      h(View, { style: [s.row, { marginTop: 12, alignItems: 'flex-start' }] },
        h(View, { style: { flex: 1, paddingRight: 14 } },
          h(View, { style: s.row },
            h(Field, { label: 'CLASS', value: d.klass, labelW: 44, boxW: 70, center: true, mt: 0 }),
            h(View, { style: { width: 14 } }),
            h(Field, { label: 'C.C. #', value: d.cc, labelW: 42, boxW: 70, center: true, mt: 0 }),
            h(View, { style: { width: 14 } }),
            h(Field, { label: 'G.R. #', value: d.gr, labelW: 42, boxW: 70, center: true, mt: 0 }),
          ),
          h(Field, { label: "STUDENT'S NAME", value: d.name, mt: 9 }),
          h(Field, { label: "FATHER'S NAME", value: d.father }),
          h(View, { style: s.row },
            h(Field, { label: 'DATE OF BIRTH', value: d.dob, boxW: 110, center: true }),
            h(View, { style: { flex: 1 } }),
            h(Field, { label: 'GROUP', value: d.group.toUpperCase(), labelW: 46, boxW: 92, center: true }),
          ),
        ),
        h(Photo, { initials: d.initials }),
      ),
      h(View, { style: [s.table, { marginTop: 12 }] },
        h(View, { style: s.thRow },
          h(Text, { style: [s.th, cs('subject')] }, 'SUBJECT'),
          h(Text, { style: [s.th, cs('date'), s.vline] }, 'DAY & DATE'),
          h(Text, { style: [s.th, cs('time'), s.vline] }, 'TIME'),
        ),
        d.papers.map((p, i) => h(View, { key: i, style: s.tr },
          h(Text, { style: [s.td, cs('subject'), { fontFamily: F.b }] }, p.subject.toUpperCase()),
          h(Text, { style: [s.td, cs('date'), s.vline] }, `${p.day}, ${p.date}`),
          h(Text, { style: [s.td, cs('time'), s.vline] }, p.time),
        )),
      ),
      h(Signatures, { rows: [
        ['HEAD OF THE SEGMENT', 'ACADEMIC DIRECTRESS', 'HEAD OF THE INSTITUTION'],
        ['ACCOUNTANT', 'DIRECTRESS ADMIN. & P.-G.', 'DIRECTRESS FINANCE'],
      ] }),
      h(View, { style: { marginTop: 8 } },
        h(Text, { style: { fontFamily: F.b, fontSize: 10, textDecoration: 'underline', marginBottom: 3 } }, 'NOTE:'),
        d.notes.map((n, i) => h(View, { key: i, style: [s.row, { alignItems: 'flex-start', marginBottom: 1.6 }] },
          h(Text, { style: { width: 14, fontSize: 8.5 } }, `${i + 1}.`),
          h(Text, { style: { flex: 1, fontSize: 8.5, lineHeight: 1.25 } }, n),
        )),
      ),
      h(View, { style: { flex: 1 } }),
      h(Footer, { campus: 'CAMPUS # II : SECONDARY SEGMENT', issued: `Day & date of issuance : ${d.issuedLong}`, right: 'Page 1 of 1' }),
    ),
  );
}

// ---------- 2. Statement of marks, Secondary ----------

function SoeSecondary(d) {
  // A subject passes on its parts' combined marks: half its maximum, rounded up.
  const subjects = d.subjects.map((sub) => {
    const parts = sub.parts || [{ label: null, max: sub.max, pass: sub.pass, got: sub.got }];
    const max = parts.reduce((a, p) => a + p.max, 0);
    const got = parts.reduce((a, p) => a + p.got, 0);
    return { ...sub, parts, max, got, cleared: got >= Math.ceil(max / 2) };
  });
  const max = subjects.reduce((a, x) => a + x.max, 0);
  const got = subjects.reduce((a, x) => a + x.got, 0);
  const cleared = subjects.filter((x) => x.cleared).length;
  const percentage = pct(got, max);
  const rows = subjects.flatMap((x) => x.parts.map((p, i) => ({
    name: p.label ? `${x.name.toUpperCase()} ${p.label.toUpperCase()}` : x.name.toUpperCase(),
    max: p.max, pass: p.pass, got: p.got, failed: !x.cleared, groupEnd: i === x.parts.length - 1,
  })));
  const W = { subject: null, max: 108, pass: 108, got: 108 };
  const cs = (k) => (W[k] ? { width: W[k] } : { flex: 1, textAlign: 'left', paddingLeft: 8 });
  const DECISIONS = ['Passed', 'Promoted', 'Promoted Conditionally', 'Failed'];

  return h(Page, { size: 'A4', style: s.page },
    h(View, { style: s.frame },
      h(Header, { classId: d.classId, logo: LOGO.sec, school: 'THE AMERICAN FOUNDATION SECONDARY SCHOOL', lines: [`STATEMENT OF MARKS · ${d.assessment.toUpperCase()}`, `SCHOLASTIC YEAR ${d.session}`, `CLASS : ${d.klass}`] }),
      h(View, { style: [s.row, { marginTop: 8, alignItems: 'flex-end' }] },
        h(View, { style: { flex: 1, paddingRight: 14 } },
          h(View, { style: s.row },
            h(Field, { label: 'SERIAL #', value: d.serial, labelW: 56, boxW: 64, center: true, mt: 0 }),
            h(View, { style: { flex: 1 } }),
            h(Field, { label: 'ROLL #', value: d.gr, labelW: 44, boxW: 64, center: true, mt: 0 }),
            h(View, { style: { width: 12 } }),
            h(Field, { label: 'GROUP', value: d.group.toUpperCase(), labelW: 44, boxW: 84, center: true, mt: 0 }),
          ),
          h(Field, { label: "STUDENT'S NAME", value: d.name, mt: 8 }),
          h(Field, { label: "FATHER'S NAME", value: d.father }),
        ),
        h(Photo, { initials: d.initials }),
      ),
      h(View, { style: [s.row, { marginTop: 8 }] },
        h(Field, { label: 'TOTAL SCHOOL DAYS', labelW: 116, value: String(d.days), boxW: 62, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'DAYS PRESENT', value: two(d.present), labelW: 80, boxW: 62, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'DAYS ABSENT', value: two(d.days - d.present), labelW: 74, boxW: 62, center: true, mt: 0 }),
      ),
      h(View, { style: [s.table, { marginTop: 10 }] },
        h(View, { style: s.thRow },
          h(Text, { style: [s.th, cs('subject'), { textAlign: 'left' }] }, 'SUBJECT'),
          h(Text, { style: [s.th, cs('max'), s.vline] }, 'MAXIMUM MARKS'),
          h(Text, { style: [s.th, cs('pass'), s.vline] }, 'MINIMUM PASS MARKS'),
          h(Text, { style: [s.th, cs('got'), s.vline] }, 'MARKS OBTAINED'),
        ),
        rows.map((r, i) => h(View, { key: i, style: [s.tr, i > 0 && !rows[i - 1].groupEnd ? { borderTopWidth: 0 } : null] },
          h(Text, { style: [s.td, cs('subject'), { fontFamily: F.b }] }, r.name),
          h(Text, { style: [s.td, cs('max'), s.vline] }, String(r.max)),
          h(Text, { style: [s.td, cs('pass'), s.vline] }, two(r.pass)),
          h(Text, { style: [s.td, cs('got'), s.vline, { fontFamily: F.b }, r.failed ? { color: FAIL } : null] }, two(r.got)),
        )),
        h(View, { style: [s.tr, { borderTopWidth: 0.9, borderTopColor: RULE, backgroundColor: SHADE }] },
          h(Text, { style: [s.td, cs('subject'), { fontFamily: F.b }] }, 'GRAND TOTAL'),
          h(Text, { style: [s.td, cs('max'), s.vline, { fontFamily: F.b }] }, String(max)),
          h(Text, { style: [s.td, cs('pass'), s.vline] }, ''),
          h(Text, { style: [s.td, cs('got'), s.vline, { fontFamily: F.b }] }, String(got)),
        ),
      ),
      h(View, { style: [s.row, { marginTop: 9 }] },
        h(Field, { label: 'NO. OF SUBJECTS CLEARED', labelW: 142, value: WORDS[cleared] ?? String(cleared), boxW: 110, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'OUT OF', labelW: 50, value: WORDS[subjects.length] ?? String(subjects.length), boxW: 110, center: true, mt: 0 }),
      ),
      h(View, { style: [s.row, { marginTop: 6 }] },
        h(Field, { label: 'PERCENTAGE', labelW: 142, value: percentage.toFixed(2), boxW: 110, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'GRADE', labelW: 50, value: d.gradeFor(percentage), boxW: 110, center: true, mt: 0 }),
      ),
      h(View, { style: [s.row, { marginTop: 9, borderWidth: 0.9, borderColor: RULE, paddingVertical: 5, paddingHorizontal: 8 }] },
        h(Text, { style: [s.label, { marginRight: 10 }] }, 'REMARKS :'),
        DECISIONS.map((x) => h(View, { key: x, style: [s.row, { flex: x === 'Promoted Conditionally' ? 1.7 : 1, justifyContent: 'center' }] },
          h(Text, { style: [{ fontSize: 10 }, x === d.decision ? { fontFamily: F.b } : null] }, x),
          h(Tick, { on: x === d.decision }),
        )),
      ),
      h(View, { style: { marginTop: 6, borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, paddingHorizontal: 8, minHeight: 34 } },
        h(Text, { style: [s.label, { fontSize: 8.5 }] }, "CLASS TEACHER'S REMARKS :"),
        h(Text, { style: { fontFamily: F.i, fontSize: 10, marginTop: 2 } }, d.remarks),
      ),
      h(View, { style: { flex: 1 } }),
      h(Signatures, { rows: [['HEAD OF THE SEGMENT', 'ACADEMIC DIRECTRESS', 'HEAD OF THE INSTITUTION']] }),
      h(Footer, { campus: 'CAMPUS # II : SECONDARY SEGMENT', issued: `DATED : ${d.issued.toUpperCase()}`, right: 'FOR IMPORTANT NOTES PLEASE TURN OVER THE PAGE' }),
    ),
  );
}

// ---------- 3. Statement of marks, A Level (Cambridge) ----------

const CAMBRIDGE = [[95, 'A*'], [85, 'A'], [75, 'B'], [66, 'C'], [61, 'D'], [55, 'E'], [0, 'U']];
const camGrade = (p) => CAMBRIDGE.find(([min]) => p >= min)[1];
const gradeLabel = (g) => `${g} ( ${g.toLowerCase()} )`;

function SoeALevel(d) {
  const rows = d.subjects.map((x) => ({ ...x, p: pct(x.got, x.max), g: camGrade(pct(x.got, x.max)) }));
  const W = { n: 30, code: 54, subject: null, max: 58, high: 64, got: 66, pct: 40, grade: 56 };
  const cs = (k) => (W[k] ? { width: W[k] } : { flex: 1 });
  return h(Page, { size: 'A4', style: s.page },
    h(View, { style: s.frame },
      h(Header, { classId: d.classId, logo: LOGO.alevel, school: 'THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES', lines: [`STATEMENT OF MARKS FOR ${d.assessment.toUpperCase()}`, 'SENIOR CAMBRIDGE', `SESSION : ${d.session}`, `LEVEL ${d.level.toUpperCase()}`] }),
      h(View, { style: [s.row, { marginTop: 8, alignItems: 'flex-end' }] },
        h(View, { style: { flex: 1, paddingRight: 14 } },
          h(View, { style: s.row },
            h(Field, { label: 'C.C. #', labelW: 116, value: d.cc, boxW: 80, center: true, mt: 0 }),
            h(View, { style: { width: 20 } }),
            h(Field, { label: 'G.R. #', value: d.gr, labelW: 44, boxW: 80, center: true, mt: 0 }),
          ),
          h(Field, { label: "STUDENT'S NAME", value: d.name, mt: 7 }),
          h(Field, { label: "FATHER'S NAME", value: d.father }),
        ),
        h(Photo, { initials: d.initials }),
      ),
      h(View, { style: [s.row, { marginTop: 8 }] },
        h(Field, { label: 'TOTAL SCHOOL DAYS', labelW: 116, value: String(d.days), boxW: 64, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'PRESENCE', labelW: 60, value: String(d.present), boxW: 64, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'ABSENCE', labelW: 58, value: String(d.days - d.present), boxW: 64, center: true, mt: 0 }),
      ),
      h(View, { style: [s.row, { marginTop: 5 }] },
        h(Field, { label: 'LATE ARRIVALS', labelW: 116, value: two(d.late), boxW: 64, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'EARLY LEAVINGS', labelW: 96, value: d.early ? two(d.early) : '-', boxW: 64, center: true, mt: 0 }),
        h(View, { style: { flex: 1 } }),
        h(Field, { label: 'H.W. PREPARATION', labelW: 108, value: d.homework.toUpperCase(), boxW: 64, center: true, mt: 0 }),
      ),
      h(View, { style: [s.table, { marginTop: 10 }] },
        h(View, { style: s.thRow },
          h(Text, { style: [s.th, cs('n')] }, 'S. #'),
          h(Text, { style: [s.th, cs('code'), s.vline] }, 'SUBJECT CODE'),
          h(Text, { style: [s.th, cs('subject'), s.vline] }, 'SUBJECT TITLE'),
          h(Text, { style: [s.th, cs('max'), s.vline] }, 'MAXIMUM MARKS'),
          h(Text, { style: [s.th, cs('high'), s.vline] }, 'HIGHEST MARKS OBTAINED'),
          h(Text, { style: [s.th, cs('got'), s.vline] }, 'MARKS OBTAINED'),
          h(Text, { style: [s.th, cs('pct'), s.vline] }, '%'),
          h(Text, { style: [s.th, cs('grade'), s.vline] }, 'GRADE'),
        ),
        rows.map((x, i) => h(View, { key: x.code, style: s.tr },
          h(Text, { style: [s.td, cs('n')] }, String(i + 1)),
          h(Text, { style: [s.td, cs('code'), s.vline] }, x.code),
          h(Text, { style: [s.td, cs('subject'), s.vline, { fontFamily: F.b }] }, x.name.toUpperCase()),
          h(Text, { style: [s.td, cs('max'), s.vline] }, String(x.max)),
          h(Text, { style: [s.td, cs('high'), s.vline] }, String(x.high)),
          h(Text, { style: [s.td, cs('got'), s.vline, { fontFamily: F.b }] }, String(x.got)),
          h(Text, { style: [s.td, cs('pct'), s.vline] }, String(Math.round(x.p))),
          h(Text, { style: [s.td, cs('grade'), s.vline, { fontFamily: F.b }, x.g === 'U' ? { color: FAIL } : null] }, gradeLabel(x.g)),
        )),
      ),
      h(View, { style: { marginTop: 8, borderWidth: 0.9, borderColor: RULE, paddingVertical: 5, paddingHorizontal: 10 } },
        h(Text, { style: { fontSize: 9.5, lineHeight: 1.3 } },
          'Grades A* (a*), A (a), B (b), C (c), D (d) and E (e) indicate the standard reached, A* (a*) being the highest and E (e) the lowest. Ungraded is shown as U (u), which is below grade E (e).'),
        h(View, { style: [s.row, { marginTop: 4, alignItems: 'flex-start' }] },
          h(Text, { style: [s.label, { width: 40 }] }, 'KEY'),
          [CAMBRIDGE.slice(0, 4), CAMBRIDGE.slice(4)].map((col, c) => h(View, { key: c, style: { flex: 1 } },
            col.map(([min, g]) => h(View, { key: g, style: [s.row, { marginBottom: 1.2 }] },
              h(Text, { style: { width: 100, fontSize: 9.5 } }, g === 'U' ? '54 % and below' : `${min} % and above`),
              h(Text, { style: { fontFamily: F.b, fontSize: 9.5 } }, gradeLabel(g)),
            )),
          )),
        ),
      ),
      h(View, { style: { marginTop: 6, borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, paddingHorizontal: 8, minHeight: 32 } },
        h(Text, { style: [s.label, { fontSize: 8.5 }] }, 'REMARKS :'),
        h(Text, { style: { fontFamily: F.i, fontSize: 10, marginTop: 2 } }, d.remarks),
      ),
      h(View, { style: { flex: 1 } }),
      h(Signatures, { rows: [['HEAD OF THE SEGMENT', 'ACADEMIC DIRECTRESS', 'HEAD OF THE INSTITUTION']] }),
      h(Footer, { campus: 'CAMPUS # II : SENIOR CAMBRIDGE SEGMENT', issued: `This statement of marks is issued on ${d.issued}.` }),
    ),
  );
}

// ---------- 4. Statement of entry, A Level (Cambridge) ----------

function StatementOfEntry(d) {
  const W = { code: 92, subject: null, day: 96, date: 74, time: 54 };
  const cs = (k) => (W[k] ? { width: W[k] } : { flex: 1, textAlign: 'left', paddingLeft: 8 });
  return h(Page, { size: 'A4', style: s.page },
    h(View, { style: s.frame },
      h(Header, { classId: d.classId, logo: LOGO.alevel, school: 'THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES', title: 'STATEMENT OF ENTRY', lines: [d.assessment.toUpperCase(), 'SENIOR CAMBRIDGE', `SESSION : ${d.session}`, `LEVEL ${d.level.toUpperCase()}`] }),
      h(View, { style: [s.row, { marginTop: 10, alignItems: 'flex-end' }] },
        h(View, { style: { flex: 1, paddingRight: 14 } },
          h(Field, { label: 'CENTRE / CANDIDATE #', value: `${d.centre} / ${d.candidate}`, labelW: 142, boxW: 120, center: true, mt: 0 }),
          h(Field, { label: "CANDIDATE'S NAME", value: d.name, labelW: 142, mt: 7 }),
          h(View, { style: s.row },
            h(Field, { label: 'DATE OF BIRTH', value: d.dob, labelW: 142, boxW: 120, center: true }),
            h(View, { style: { flex: 1 } }),
            h(Field, { label: 'GENDER', value: d.gender, labelW: 50, boxW: 40, center: true }),
          ),
          h(Field, { label: 'PREVIOUS ENTRY DETAIL', value: d.previous || '-', labelW: 142 }),
        ),
        h(Photo, { initials: d.initials }),
      ),
      h(View, { style: [s.table, { marginTop: 12 }] },
        h(View, { style: s.thRow },
          h(Text, { style: [s.th, cs('code')] }, 'SYLLABUS / COMPONENT CODE'),
          h(Text, { style: [s.th, cs('subject'), s.vline, { textAlign: 'left' }] }, 'SYLLABUS AND COMPONENT TITLE'),
          h(Text, { style: [s.th, cs('day'), s.vline] }, 'ASSESSMENT DAY'),
          h(Text, { style: [s.th, cs('date'), s.vline] }, 'ASSESSMENT DATE'),
          h(Text, { style: [s.th, cs('time'), s.vline] }, 'TIME'),
        ),
        d.papers.map((p, i) => h(View, { key: i, style: s.tr },
          h(Text, { style: [s.td, cs('code'), { paddingVertical: 6.5 }] }, p.code),
          h(Text, { style: [s.td, cs('subject'), s.vline, { fontFamily: F.b, paddingVertical: 6.5 }] }, p.subject.toUpperCase()),
          h(Text, { style: [s.td, cs('day'), s.vline, { paddingVertical: 6.5 }] }, p.day.toUpperCase()),
          h(Text, { style: [s.td, cs('date'), s.vline, { paddingVertical: 6.5 }] }, p.date.toUpperCase()),
          h(Text, { style: [s.td, cs('time'), s.vline, { paddingVertical: 6.5 }] }, p.time),
        )),
      ),
      h(View, { style: { marginTop: 9, borderWidth: 0.9, borderColor: RULE, paddingVertical: 5, paddingHorizontal: 8 } },
        d.notes.map((n, i) => h(View, { key: i, style: [s.row, { alignItems: 'flex-start', marginTop: i ? 2 : 0 }] },
          h(Text, { style: { width: 12, fontSize: 9.5 } }, '•'),
          h(Text, { style: { flex: 1, fontFamily: F.b, fontSize: 9.5 } }, n),
        )),
      ),
      h(View, { style: { flex: 1 } }),
      h(Signatures, { rows: [
        ['HEAD OF THE SEGMENT', 'ACADEMIC DIRECTRESS', 'HEAD OF THE INSTITUTION'],
        ['ACCOUNTANT', 'DIRECTRESS ADMIN. & P.-G.', 'DIRECTRESS FINANCE'],
      ] }),
      h(Footer, { campus: 'CAMPUS # II : SENIOR CAMBRIDGE SEGMENT', issued: `Day & date of issuance : ${d.issuedLong}`, right: 'Please turn over for the rules of assessments' }),
    ),
  );
}

// ---------- sample data (made up) ----------

const NOTES = [
  'Bring this admit card every day. Without it you will not be allowed to appear in the assessment.',
  'Regular school timings will be followed during the oral assessments.',
  'Only simple calculators are allowed. Bring stationery in a transparent pouch; no lending or borrowing.',
  'Bags, notebooks and the use of assessment boards are not allowed during the assessments.',
  'Resource materials: lectures, textbooks, reference books and registers / notebooks.',
  "If school is closed on an assessment day, that paper will be held after the last scheduled paper. No pre or post assessment will be conducted.",
  'Kindly review the work done with your child so that he / she may achieve the best grades.',
  'The result will be distributed in the PTM on Saturday, 31 October 2026, In Sha Allah.',
];

const admit = {
  assessment: 'First Semester Assessments', session: '2026 – 2027', initials: 'AK',
  classId: 15, name: 'AYESHA KAMRAN', father: 'KAMRAN SALEEM', dob: '14.03.2015', klass: 'VI – B', group: 'Science',
  cc: '7412', gr: '6120', issuedLong: 'Monday, September 21, 2026', notes: NOTES,
  papers: [
    ['Mon', '28-09-2026', 'Science Practical'],
    ['Tue', '29-09-2026', 'Computer Practical'],
    ['Wed', '30-09-2026', 'Mathematics'],
    ['Thu', '01-10-2026', 'English'],
    ['Fri', '02-10-2026', 'Islamiat'],
    ['Mon', '05-10-2026', 'Social Studies'],
    ['Tue', '06-10-2026', 'Computer Theory'],
    ['Wed', '07-10-2026', 'Urdu'],
    ['Thu', '08-10-2026', 'Sindhi'],
    ['Fri', '09-10-2026', 'Science Theory'],
  ].map(([day, date, subject]) => ({ day, date, subject, time: '08:00 AM – 12:30 PM' })),
};

// Secondary grade scale is a placeholder until the school confirms its own.
const secGrade = (p) => (p >= 80 ? 'A-1' : p >= 70 ? 'A' : p >= 60 ? 'B' : p >= 50 ? 'C' : p >= 40 ? 'D' : 'U');

const soe6 = {
  assessment: 'First Semester Assessments', session: '2026 – 2027', initials: 'AK',
  classId: 15, name: 'AYESHA KAMRAN', father: 'KAMRAN SALEEM', klass: 'VI', group: 'Science', serial: '0009', gr: '6120',
  days: 46, present: 45, gradeFor: secGrade, decision: 'Passed',
  remarks: 'Attentive and well prepared. Urdu needs regular reading practice at home.',
  issued: 'Saturday, October 31, 2026',
  subjects: [
    { name: 'English', max: 100, pass: 50, got: 62 },
    { name: 'Urdu', max: 100, pass: 50, got: 36 },
    { name: 'Islamiat', max: 100, pass: 50, got: 68 },
    { name: 'Mathematics', max: 100, pass: 50, got: 75 },
    { name: 'Social Studies', max: 100, pass: 50, got: 55 },
    { name: 'Sindhi', max: 100, pass: 50, got: 78 },
    { name: 'Science', parts: [{ label: 'Theory', max: 85, pass: 43, got: 69 }, { label: 'Practical', max: 15, pass: 8, got: 11 }] },
    { name: 'Computer', parts: [{ label: 'Theory', max: 85, pass: 43, got: 55 }, { label: 'Practical', max: 15, pass: 8, got: 14 }] },
  ],
};

const soe9 = {
  assessment: 'First Semester Assessments', session: '2026 – 2027', initials: 'BR',
  classId: 18, name: 'BILAL RAZA', father: 'RAZA AHMED', klass: 'IX', group: 'Computer', serial: '0033', gr: '6472',
  days: 46, present: 33, gradeFor: secGrade, decision: 'Failed',
  remarks: 'Thirteen days absent this term. A meeting with parents is requested before the second semester.',
  issued: 'Saturday, October 31, 2026',
  subjects: [
    { name: 'English', max: 100, pass: 50, got: 50 },
    { name: 'Urdu', max: 75, pass: 38, got: 12 },
    { name: 'Islamiat', max: 75, pass: 38, got: 32 },
    { name: 'Mathematics', max: 75, pass: 38, got: 17 },
    { name: 'Chemistry', parts: [{ label: 'Theory', max: 60, pass: 30, got: 2 }, { label: 'Practical', max: 15, pass: 8, got: 7 }] },
    { name: 'Physics', parts: [{ label: 'Theory', max: 60, pass: 30, got: 15 }, { label: 'Practical', max: 15, pass: 8, got: 8 }] },
    { name: 'Computer', parts: [{ label: 'Theory', max: 60, pass: 30, got: 15 }, { label: 'Practical', max: 15, pass: 8, got: 5 }] },
  ],
};

const somAL = {
  assessment: 'First Midterm Assessments', session: '2026 – 2027', initials: 'HA',
  classId: 9, name: 'HAMZA ARIF', father: 'ARIF QURESHI', level: 'Sr. I A', cc: '7384', gr: '6099',
  days: 44, present: 44, late: 1, early: 0, homework: 'Good',
  remarks: 'Strong in the sciences. Mathematics and Urdu need extra practice before the second midterm.',
  issued: 'Saturday, October 31, 2026',
  subjects: [
    ['2058', 'Islamiyat', 25, 25, 19],
    ['2059', 'History', 25, 25, 20],
    ['2217', 'Geography', 25, 25, 17],
    ['3248', 'Urdu', 25, 24, 10],
    ['1123', 'English', 25, 24, 14],
    ['4024', 'Mathematics', 25, 25, 13],
    ['5090', 'Biology', 25, 25, 20],
    ['5070', 'Chemistry', 25, 25, 22],
    ['5054', 'Physics', 25, 24, 18],
    ['2210', 'Computer Science', 25, 22, 15],
  ].map(([code, name, max, high, got]) => ({ code, name, max, high, got })),
};

const soeAL = {
  assessment: 'First Semester Assessments', session: '2026 – 2027', initials: 'HA', level: 'Sr. I A', classId: 9,
  name: 'HAMZA ARIF', dob: '22.05.2014', gender: 'M', centre: 'PK 564', candidate: '4137', previous: '',
  issuedLong: 'Monday, December 7, 2026',
  notes: [
    'All entry details, including the spelling of your name and date of birth, must be checked for accuracy.',
    'Bring this statement of entry every day until the last day of the assessments.',
  ],
  papers: [
    ['4024', 'Mathematics', 'Thursday', '11 Dec'],
    ['2059 / 01', 'History', 'Friday', '12 Dec'],
    ['5070', 'Chemistry', 'Saturday', '13 Dec'],
    ['3248', 'Urdu', 'Monday', '15 Dec'],
    ['5054', 'Physics', 'Tuesday', '16 Dec'],
    ['1123', 'English', 'Wednesday', '17 Dec'],
    ['2210', 'Computer Science', 'Thursday', '18 Dec'],
    ['5090', 'Biology', 'Friday', '19 Dec'],
    ['2058', 'Islamiyat', 'Saturday', '20 Dec'],
    ['2059 / 02', 'Geography', 'Monday', '22 Dec'],
  ].map(([code, subject, day, date]) => ({ code, subject, day, date, time: 'AM' })),
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const docs = [
    ['1 Admit card - VI.pdf', h(Document, { title: 'Admit card' }, h(AdmitCard, admit))],
    ['2 Statement of marks - Secondary VI (passed).pdf', h(Document, { title: 'Statement of marks' }, h(SoeSecondary, soe6))],
    ['3 Statement of marks - Secondary IX (failed).pdf', h(Document, { title: 'Statement of marks' }, h(SoeSecondary, soe9))],
    ['4 Statement of marks - A Level Sr I.pdf', h(Document, { title: 'Statement of marks' }, h(SoeALevel, somAL))],
    ['5 Statement of entry - A Level Sr I.pdf', h(Document, { title: 'Statement of entry' }, h(StatementOfEntry, soeAL))],
  ];
  for (const [file, doc] of docs) {
    await renderToFile(doc, path.join(OUT, file));
    console.log('wrote', file);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
