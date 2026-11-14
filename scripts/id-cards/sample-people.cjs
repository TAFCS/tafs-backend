// Made-up people for the ID card samples (TAFSD-518). No real student, parent or
// staff member: names, G.R. numbers, phone numbers and addresses are invented.
'use strict';

const ISSUE = 'NOVEMBER 14, 2026';
const VALID = 'JULY 31, 2027';
const HOUSES = ['SIR SYED', 'JINNAH', 'LIAQUAT', 'IQBAL'];

function students(rows, extra = {}) {
  return rows.map((r, i) => ({
    house: HOUSES[i % 4],
    issueDate: ISSUE,
    validUpto: VALID,
    ...extra,
    ...r,
  }));
}

const PRE_PRIMARY_PARENTS = [
  { fatherName: 'MUHAMMAD IMRAN SHEIKH', address: 'A-14, BLOCK - H, NORTH NAZIMABAD', residencePhone: '021-36630001', cellPhone: '0300-1112233', contactPhone: '0321-4455667', nearestPhone: '' },
  { fatherName: 'SYED KASHIF ALI', address: 'FLAT 302, AL-NOOR TOWER, BLOCK - L', residencePhone: '', cellPhone: '0333-2223344', contactPhone: '0345-6677889', nearestPhone: '0312-9988776' },
  { fatherName: 'ADNAN RAZA KHAN', address: 'R-55, SECTOR 11-B, NORTH KARACHI', residencePhone: '021-36990012', cellPhone: '0301-5566778', contactPhone: '', nearestPhone: '0300-4433221' },
  { fatherName: 'FAISAL AHMED QURESHI', address: 'B-9, BLOCK - N, NORTH NAZIMABAD', residencePhone: '', cellPhone: '0322-7788990', contactPhone: '0331-1234509', nearestPhone: '' },
];

const JAUHAR_PARENTS = [
  { fatherName: 'TARIQ MEHMOOD', address: 'B - 214, SAIMA ARABIAN VILLAS, BLOCK - 13, G-E-J', residencePhone: '021-34610021', cellPhone: '0300-2345678', contactPhone: '0321-8765432', nearestPhone: '' },
  { fatherName: 'SYED AAMIR HUSSAIN', address: 'FLAT A-7, RUFI LAKE DRIVE, BLOCK - 18, G-E-J', residencePhone: '', cellPhone: '0333-3456789', contactPhone: '0345-1928374', nearestPhone: '0300-5647382' },
  { fatherName: 'KHALID MAHMOOD BAIG', address: 'HOUSE R-31, BLOCK - 15, GULISTAN-E-JAUHAR', residencePhone: '021-34015566', cellPhone: '0301-6789012', contactPhone: '', nearestPhone: '0312-3344556' },
  { fatherName: 'NAVEED AKHTAR', address: 'C - 9, PERFECT HOMES, BLOCK - 10-A, G-E-J', residencePhone: '', cellPhone: '0322-1029384', contactPhone: '0331-5647381', nearestPhone: '' },
];

const KF_PARENTS = [
  { fatherName: 'ZAHID HUSSAIN MALIK', address: 'B - 41, GULSHAN-E-KANEEZ FATIMA, SCHEME 33', residencePhone: '021-34690101', cellPhone: '0300-9081726', contactPhone: '0321-3141592', nearestPhone: '' },
  { fatherName: 'SAJID IQBAL', address: 'A - 7, GULZAR-E-HIJRI, SCHEME 33', residencePhone: '', cellPhone: '0333-2718281', contactPhone: '0345-1618033', nearestPhone: '0312-1414213' },
  { fatherName: 'HAMID ALI SHAH', address: 'FLAT 12, SAFARI BOULEVARD, SCHEME 33', residencePhone: '021-34690456', cellPhone: '0301-1732050', contactPhone: '', nearestPhone: '0300-2236067' },
  { fatherName: 'ASIF NAWAZ', address: 'R - 88, KANEEZ FATIMA SOCIETY, BLOCK 4', residencePhone: '', cellPhone: '0322-2645751', contactPhone: '0331-3316624', nearestPhone: '' },
];

module.exports = {
  'pre-primary-nnn': students([
    { name: 'AYAAN IMRAN', classLine: 'EARLY YEAR 1 - A', gr: '3502', ...PRE_PRIMARY_PARENTS[0] },
    { name: 'HANIA KASHIF', classLine: 'EARLY YEAR 2 - B', gr: '3418', ...PRE_PRIMARY_PARENTS[1] },
    { name: 'MUHAMMAD RAYYAN KHAN', classLine: 'EARLY YEAR 3', gr: '3377', ...PRE_PRIMARY_PARENTS[2] },
    { name: 'ZOYA FAISAL', classLine: 'EARLY YEAR 1 - B', gr: '3511', ...PRE_PRIMARY_PARENTS[3] },
  ]),
  'pre-primary-gkf': students([
    { name: 'ABDUL HADI ZAHID', classLine: 'EARLY YEAR 2 - A', gr: '1205', ...KF_PARENTS[0] },
    { name: 'MANAHIL SAJID', classLine: 'EARLY YEAR 1', gr: '1231', ...KF_PARENTS[1] },
    { name: 'SYED MUHAMMAD AHMED SHAH', classLine: 'EARLY YEAR 3 - B', gr: '1188', ...KF_PARENTS[2] },
    { name: 'INAYA ASIF', classLine: 'EARLY YEAR 2 - B', gr: '1240', ...KF_PARENTS[3] },
  ]),
  'pre-primary-jauhar': students([
    { name: 'MUHAMMAD ALI TARIQ', classLine: 'EARLY YEAR 1 - B', gr: '6620', ...JAUHAR_PARENTS[0] },
    { name: 'FATIMA AAMIR', classLine: 'EARLY YEAR 2 - A', gr: '6587', ...JAUHAR_PARENTS[1] },
    { name: 'IBRAHIM KHALID BAIG', classLine: 'EARLY YEAR 3 - C', gr: '6531', ...JAUHAR_PARENTS[2] },
    { name: 'AMNA NAVEED', classLine: 'EARLY YEAR 1 - A', gr: '6634', ...JAUHAR_PARENTS[3] },
  ]),
  'junior-cambridge-jauhar': students([
    { name: 'HAMZA TARIQ', classLine: 'JR - II D', gr: '2591', ...JAUHAR_PARENTS[0] },
    { name: 'AREEBA AAMIR HUSSAIN', classLine: 'JR - IV A', gr: '2433', ...JAUHAR_PARENTS[1] },
    { name: 'ABDULLAH KHALID', classLine: 'JR - V B', gr: '2301', ...JAUHAR_PARENTS[2] },
    { name: 'MAHNOOR NAVEED', classLine: 'JR - I C', gr: '2655', ...JAUHAR_PARENTS[3] },
  ]),
  'senior-cambridge-jauhar': students([
    { name: 'SAAD TARIQ MEHMOOD', classLine: 'SR - I A', gr: '1522', ...JAUHAR_PARENTS[0] },
    { name: 'ALIZEH AAMIR', classLine: 'SR - II B', gr: '1490', ...JAUHAR_PARENTS[1] },
    { name: 'MUHAMMAD UMAR BAIG', classLine: 'SR - III C', gr: '1451', ...JAUHAR_PARENTS[2] },
    { name: 'HAFSA NAVEED', classLine: 'SR - III B', gr: '1463', ...JAUHAR_PARENTS[3] },
  ]),
  'o-level-jauhar': students([
    { name: 'DANIYAL TARIQ', classLine: 'O - I', gr: '3420', ...JAUHAR_PARENTS[0] },
    { name: 'ANAYA AAMIR HUSSAIN', classLine: 'O - II', gr: '3388', ...JAUHAR_PARENTS[1] },
    { name: 'AHMED RAZA BAIG', classLine: 'O - III', gr: '3301', ...JAUHAR_PARENTS[2] },
    { name: 'EMAN NAVEED AKHTAR', classLine: 'O - III', gr: '3319', ...JAUHAR_PARENTS[3] },
  ]),
  'secondary-jauhar': students([
    { name: 'USMAN TARIQ', classLine: 'VI', gr: '981', ...JAUHAR_PARENTS[0] },
    { name: 'SANA AAMIR', classLine: 'VIII - B', gr: '902', ...JAUHAR_PARENTS[1] },
    { name: 'BILAL KHALID BAIG', classLine: 'IX', gr: '874', ...JAUHAR_PARENTS[2] },
    { name: 'RIDA NAVEED', classLine: 'X', gr: '851', ...JAUHAR_PARENTS[3] },
  ]),
  'a-level-jauhar': students([
    { name: 'SYED MUHAMMAD HASSAN ZAIDI', level: 'AS', section: 'A', gr: '0211', group: 'SCIENCE', email: 'hassan.zaidi@example.com', ...JAUHAR_PARENTS[1] },
    { name: 'MARYAM TARIQ', level: 'AS', section: 'C', gr: '0224', group: 'COMMERCE', email: 'maryam.tariq@example.com', ...JAUHAR_PARENTS[0] },
    { name: 'MUHAMMAD AHSAN BAIG', level: 'A2', section: 'B', gr: '0158', group: 'SCIENCE', email: '', ...JAUHAR_PARENTS[2] },
    { name: 'ZAINAB NAVEED AKHTAR', level: 'A2', section: 'A', gr: '0163', group: 'HUMANITIES', email: 'zainab.akhtar@example.com', ...JAUHAR_PARENTS[3] },
  ]),

  'parent-kaneez-fatima': [
    { studentName: 'ABDUL HADI ZAHID', level: 'E.Y.2', section: 'A', gr: '1205', issueDate: ISSUE, validUpto: 'MAY 31, 2027' },
    { studentName: 'MANAHIL SAJID', level: 'E.Y.1', section: '', gr: '1231', issueDate: ISSUE, validUpto: 'MAY 31, 2027' },
  ],
  'parent-north-nazimabad': [
    { studentName: 'HANIA KASHIF', level: 'E.Y.2', section: 'B', gr: '3418', issueDate: ISSUE, validUpto: 'MAY 31, 2027' },
    { studentName: 'MUHAMMAD RAYYAN KHAN', level: 'E.Y.3', section: '', gr: '3377', issueDate: ISSUE, validUpto: 'MAY 31, 2027' },
  ],
  'parent-jauhar': [
    { studentName: 'MUHAMMAD ALI TARIQ', level: 'E.Y.1', section: 'B', gr: '6620', issueDate: ISSUE, validUpto: 'MAY 31, 2027' },
    { studentName: 'IBRAHIM KHALID BAIG', level: 'E.Y.3', section: 'C', gr: '6531', issueDate: ISSUE, validUpto: 'MAY 31, 2027' },
  ],

  'staff-administration': [
    { name: 'MRS. SADIA KAMRAN', designation: 'VICE PRINCIPAL', cnic: '42201-1234567-8', employeeNo: '03-00612', relation: 'husband', relationName: 'KAMRAN ASLAM', joiningDate: 'AUGUST 01, 2019', addressLine1: 'FLAT 4, PLOT 18-C, STREET 7,', addressLine2: 'BADAR COMMERCIAL, DHA PHASE 5, KARACHI', residencePhone: '', mobilePhone: '0300-8899001', nearestPhone: '0321-6655443', issueDate: ISSUE, validUpto: VALID },
    { name: 'MR. FARHAN SIDDIQUI', designation: 'ADMINISTRATOR', cnic: '42101-7654321-3', employeeNo: '03-00698', relation: 'father', relationName: 'NASIR SIDDIQUI', joiningDate: 'MARCH 15, 2022', addressLine1: 'B-77, BLOCK 13-D/1,', addressLine2: 'GULSHAN-E-IQBAL, KARACHI', residencePhone: '021-34981234', mobilePhone: '0333-2211009', nearestPhone: '', issueDate: ISSUE, validUpto: VALID },
  ],
  'staff-faculty-jauhar': [
    { name: 'MS. AYESHA NOOR', designation: 'TEACHER', cnic: '42101-2468135-7', employeeNo: '02-01422', relation: 'husband', relationName: 'MUHAMMAD NOMAN', joiningDate: 'SEPTEMBER 01, 2025', addressLine1: 'A-12, BLOCK 17,', addressLine2: 'GULISTAN-E-JAUHAR, KARACHI', residencePhone: '', mobilePhone: '0312-5566778', nearestPhone: '0300-1122334', issueDate: ISSUE, validUpto: VALID },
    { name: 'MR. HASSAN RAZA', designation: 'SUBJECT COORDINATOR', cnic: '42301-1357924-6', employeeNo: '02-01107', relation: 'father', relationName: 'ALI AKBAR RAZA', joiningDate: 'AUGUST 10, 2021', addressLine1: 'H-45, SECTOR 5-C/2,', addressLine2: 'NORTH KARACHI, KARACHI', residencePhone: '021-36901122', mobilePhone: '0345-9988776', nearestPhone: '', issueDate: ISSUE, validUpto: VALID },
  ],
};
