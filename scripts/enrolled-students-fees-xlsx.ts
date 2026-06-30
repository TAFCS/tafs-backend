import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import path from 'path';

const prisma = new PrismaClient();
const OUTPUT_DIR = '/Users/aawaizali/Desktop/TAFS';
const FEE_TYPE_ID = 1;

const PERIODS = [
    { month: 5, label: 'May-26',  academicYear: '2025-2026' },
    { month: 6, label: 'Jun-26',  academicYear: '2025-2026' },
    { month: 7, label: 'Jul-26',  academicYear: '2025-2026' },
    { month: 8, label: 'Aug-26',  academicYear: '2026-2027' },
    { month: 9, label: 'Sep-26',  academicYear: '2026-2027' },
];

const periodKey = (month: number, ay: string) => `${ay}:${month}`;

const HEADER_FILL: ExcelJS.Fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' }
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const AMOUNT_FILL: ExcelJS.Fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' }
};

function addSheet(
    wb: ExcelJS.Workbook,
    sheetName: string,
    students: any[],
    feeMap: Map<number, Map<string, any>>
) {
    const ws = wb.addWorksheet(sheetName);

    const cols = [
        { header: 'CC',        key: 'cc',       width: 8 },
        { header: 'GR',        key: 'gr',        width: 10 },
        { header: 'Full Name', key: 'name',      width: 30 },
        ...PERIODS.map(p => ({ header: p.label, key: p.label, width: 12 })),
        { header: 'Note',      key: 'note',      width: 18 },
    ];
    ws.columns = cols;

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
        cell.fill = HEADER_FILL;
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
            bottom: { style: 'thin', color: { argb: 'FF000000' } }
        };
    });
    headerRow.height = 20;

    for (const s of students) {
        const pmap = feeMap.get(s.cc);
        let note = '';
        if (!pmap || pmap.size === 0) {
            if (s.is_complementary) note = 'COMPLEMENTARY';
            else if (s.is_fee_endowment) note = 'FEE_ENDOWMENT';
        }

        const rowData: Record<string, any> = {
            cc:   s.cc,
            gr:   s.gr_number || '',
            name: s.full_name,
            note,
        };
        for (const p of PERIODS) {
            const fee = pmap?.get(periodKey(p.month, p.academicYear));
            rowData[p.label] = fee?.amount != null ? Number(fee.amount) : null;
        }

        const row = ws.addRow(rowData);

        // Style amount cells
        for (let ci = 4; ci <= 3 + PERIODS.length; ci++) {
            const cell = row.getCell(ci);
            cell.fill = AMOUNT_FILL;
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right' };
        }

        // Highlight complementary/endowment rows
        if (note) {
            row.getCell('note').font = { bold: true, color: { argb: 'FFCC0000' } };
        }
    }

    // Freeze header row
    ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function main() {
    // --- Fetch students with campus + class ---
    const students = await prisma.students.findMany({
        where: { status: 'ENROLLED', deleted_at: null },
        select: {
            cc: true,
            gr_number: true,
            full_name: true,
            campus_id: true,
            is_complementary: true,
            is_fee_endowment: true,
            classes: { select: { id: true, description: true } },
        },
        orderBy: [{ campus_id: 'asc' }, { class_id: 'asc' }, { cc: 'asc' }]
    });

    // --- Fetch campuses ---
    const campuses = await prisma.campuses.findMany({
        select: { id: true, campus_name: true },
        orderBy: { id: 'asc' }
    });

    // --- Fetch fees ---
    const allFees = await prisma.student_fees.findMany({
        where: {
            fee_type_id: FEE_TYPE_ID,
            is_discount: false,
            is_arrear_surcharge: false,
            OR: [
                { academic_year: '2025-2026', target_month: { in: [5, 6, 7] } },
                { academic_year: '2026-2027', target_month: { in: [8, 9] } },
            ]
        },
        select: { student_id: true, target_month: true, academic_year: true, amount: true }
    });

    // Build fee map
    const feeMap = new Map<number, Map<string, typeof allFees[0]>>();
    for (const f of allFees) {
        const k = periodKey(f.target_month, f.academic_year);
        if (!feeMap.has(f.student_id)) feeMap.set(f.student_id, new Map());
        if (!feeMap.get(f.student_id)!.has(k)) {
            feeMap.get(f.student_id)!.set(k, f);
        }
    }

    console.log(`Students: ${students.length} | Fee rows: ${allFees.length} | Campuses: ${campuses.length}`);

    // --- Group students: campusId -> classDescription -> students[] ---
    const byCampus = new Map<number, Map<string, typeof students>>();
    for (const s of students) {
        const cid = s.campus_id ?? 0;
        const cls = s.classes?.description ?? 'Unknown Class';
        if (!byCampus.has(cid)) byCampus.set(cid, new Map());
        const byClass = byCampus.get(cid)!;
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls)!.push(s);
    }

    // --- Generate one XLSX per campus ---
    for (const campus of campuses) {
        const byClass = byCampus.get(campus.id);
        if (!byClass || byClass.size === 0) {
            console.log(`  ${campus.campus_name}: no enrolled students, skipping`);
            continue;
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = 'TAFS';
        wb.created = new Date();

        const sortedClasses = Array.from(byClass.keys()).sort();
        let totalStudents = 0;
        for (const cls of sortedClasses) {
            const classStudents = byClass.get(cls)!;
            totalStudents += classStudents.length;
            // Sheet names max 31 chars in Excel
            const sheetName = cls.length > 31 ? cls.slice(0, 31) : cls;
            addSheet(wb, sheetName, classStudents, feeMap);
        }

        // Sanitize campus name for filename
        const safeName = campus.campus_name.replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_');
        const filePath = path.join(OUTPUT_DIR, `${safeName}_fees_may-sep26.xlsx`);
        await wb.xlsx.writeFile(filePath);
        console.log(`  [${campus.campus_name}] ${totalStudents} students, ${sortedClasses.length} class sheets → ${filePath}`);
    }

    console.log('\nDone.');
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
