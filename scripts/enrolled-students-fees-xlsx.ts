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
const FAMILY_FILL: ExcelJS.Fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAE8FC' }
};

function styleAmountCells(row: ExcelJS.Row, startCol: number, count: number) {
    for (let ci = startCol; ci < startCol + count; ci++) {
        const cell = row.getCell(ci);
        cell.fill = AMOUNT_FILL;
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
    }
}

function addStudentRow(
    ws: ExcelJS.Worksheet,
    s: any,
    feeMap: Map<number, Map<string, any>>,
    extraCols: { key: string; value: any }[] = []
) {
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
        class: s.classes?.description || '',
        note,
    };
    for (const ec of extraCols) rowData[ec.key] = ec.value;
    for (const p of PERIODS) {
        const fee = pmap?.get(periodKey(p.month, p.academicYear));
        rowData[p.label] = fee?.amount != null ? Number(fee.amount) : null;
    }

    const row = ws.addRow(rowData);
    // amount cols start at 5 (after cc, gr, name, class) for base sheet; siblings has family col too
    const amountStart = extraCols.length > 0 ? 6 : 5;
    styleAmountCells(row, amountStart, PERIODS.length);

    if (note) row.getCell('note').font = { bold: true, color: { argb: 'FFCC0000' } };

    return row;
}

function applyHeader(ws: ExcelJS.Worksheet) {
    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
        cell.fill = HEADER_FILL;
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
    });
    headerRow.height = 20;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function addSheet(
    wb: ExcelJS.Workbook,
    sheetName: string,
    students: any[],
    feeMap: Map<number, Map<string, any>>
) {
    const ws = wb.addWorksheet(sheetName);
    ws.columns = [
        { header: 'CC',        key: 'cc',    width: 8  },
        { header: 'GR',        key: 'gr',    width: 10 },
        { header: 'Full Name', key: 'name',  width: 30 },
        { header: 'Class',     key: 'class', width: 18 },
        ...PERIODS.map(p => ({ header: p.label, key: p.label, width: 12 })),
        { header: 'Note',      key: 'note',  width: 18 },
    ];
    applyHeader(ws);
    for (const s of students) addStudentRow(ws, s, feeMap);
}

function addSiblingsSheet(
    wb: ExcelJS.Workbook,
    campusStudents: any[],
    feeMap: Map<number, Map<string, any>>,
    familyNameMap: Map<number, string>
) {
    // Build familyId → students[], keep only families with ≥2 enrolled students
    const byFamily = new Map<number, any[]>();
    for (const s of campusStudents) {
        if (s.family_id == null) continue;
        if (!byFamily.has(s.family_id)) byFamily.set(s.family_id, []);
        byFamily.get(s.family_id)!.push(s);
    }
    const multiChildFamilies = Array.from(byFamily.entries())
        .filter(([, members]) => members.length >= 2)
        .sort(([a], [b]) => a - b);

    if (multiChildFamilies.length === 0) return; // no siblings on this campus

    const ws = wb.addWorksheet('Siblings');
    ws.columns = [
        { header: 'CC',        key: 'cc',     width: 8  },
        { header: 'GR',        key: 'gr',     width: 10 },
        { header: 'Full Name', key: 'name',   width: 30 },
        { header: 'Class',     key: 'class',  width: 18 },
        { header: 'Family',    key: 'family', width: 28 },
        ...PERIODS.map(p => ({ header: p.label, key: p.label, width: 12 })),
        { header: 'Note',      key: 'note',   width: 18 },
    ];
    applyHeader(ws);

    for (const [familyId, members] of multiChildFamilies) {
        const householdName = familyNameMap.get(familyId) ?? `Family #${familyId}`;
        const sorted = [...members].sort((a, b) => a.cc - b.cc);

        for (const s of sorted) {
            const row = addStudentRow(ws, s, feeMap, [{ key: 'family', value: householdName }]);
            // Tint the family cell to visually group rows
            row.getCell('family').fill = FAMILY_FILL;
        }

        // Blank separator between families
        ws.addRow({});
    }

    return multiChildFamilies.length;
}

async function main() {
    // Fetch students (include family_id)
    const students = await prisma.students.findMany({
        where: { status: 'ENROLLED', deleted_at: null },
        select: {
            cc: true,
            gr_number: true,
            full_name: true,
            campus_id: true,
            family_id: true,
            is_complementary: true,
            is_fee_endowment: true,
            classes: { select: { id: true, description: true } },
        },
        orderBy: [{ campus_id: 'asc' }, { class_id: 'asc' }, { cc: 'asc' }]
    });

    const campuses = await prisma.campuses.findMany({
        select: { id: true, campus_name: true },
        orderBy: { id: 'asc' }
    });

    // Fetch family names for all family_ids present
    const familyIds = [...new Set(students.map(s => s.family_id).filter((id): id is number => id != null))];
    const families = await prisma.families.findMany({
        where: { id: { in: familyIds } },
        select: { id: true, household_name: true }
    });
    const familyNameMap = new Map(families.map(f => [f.id, f.household_name]));

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

    const feeMap = new Map<number, Map<string, typeof allFees[0]>>();
    for (const f of allFees) {
        const k = periodKey(f.target_month, f.academic_year);
        if (!feeMap.has(f.student_id)) feeMap.set(f.student_id, new Map());
        if (!feeMap.get(f.student_id)!.has(k)) feeMap.get(f.student_id)!.set(k, f);
    }

    console.log(`Students: ${students.length} | Fee rows: ${allFees.length} | Families: ${familyIds.length}`);

    // Group: campusId → classDescription → students[]
    const byCampus = new Map<number, { byClass: Map<string, any[]>; all: any[] }>();
    for (const s of students) {
        const cid = s.campus_id ?? 0;
        if (!byCampus.has(cid)) byCampus.set(cid, { byClass: new Map(), all: [] });
        const entry = byCampus.get(cid)!;
        entry.all.push(s);
        const cls = s.classes?.description ?? 'Unknown Class';
        if (!entry.byClass.has(cls)) entry.byClass.set(cls, []);
        entry.byClass.get(cls)!.push(s);
    }

    for (const campus of campuses) {
        const entry = byCampus.get(campus.id);
        if (!entry || entry.all.length === 0) {
            console.log(`  ${campus.campus_name}: no enrolled students, skipping`);
            continue;
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = 'TAFS';
        wb.created = new Date();

        const sortedClasses = Array.from(entry.byClass.keys()).sort();
        for (const cls of sortedClasses) {
            const sheetName = cls.length > 31 ? cls.slice(0, 31) : cls;
            addSheet(wb, sheetName, entry.byClass.get(cls)!, feeMap);
        }

        const siblingFamilyCount = addSiblingsSheet(wb, entry.all, feeMap, familyNameMap);

        const safeName = campus.campus_name.replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_');
        const filePath = path.join(OUTPUT_DIR, `${safeName}_fees_may-sep26.xlsx`);
        await wb.xlsx.writeFile(filePath);
        console.log(`  [${campus.campus_name}] ${entry.all.length} students, ${sortedClasses.length} class sheets + Siblings sheet (${siblingFamilyCount ?? 0} families) → ${filePath}`);
    }

    console.log('\nDone.');
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
