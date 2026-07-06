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
const SIBLING_FILL: ExcelJS.Fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' }
};

function addStudentRow(
    ws: ExcelJS.Worksheet,
    s: any,
    feeMap: Map<number, Map<string, any>>,
    isPulledSibling: boolean
) {
    const pmap = feeMap.get(s.cc);
    let note = '';
    if (!pmap || pmap.size === 0) {
        if (s.is_complementary) note = 'COMPLEMENTARY';
        else if (s.is_fee_endowment) note = 'FEE_ENDOWMENT';
    }

    const rowData: Record<string, any> = {
        cc:    s.cc,
        gr:    s.gr_number || '',
        name:  s.full_name,
        class: s.classes?.description || '',
        note,
    };
    for (const p of PERIODS) {
        const fee = pmap?.get(periodKey(p.month, p.academicYear));
        rowData[p.label] = fee?.amount != null ? Number(fee.amount) : null;
    }

    const row = ws.addRow(rowData);

    for (let ci = 5; ci < 5 + PERIODS.length; ci++) {
        const cell = row.getCell(ci);
        cell.fill = AMOUNT_FILL;
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
    }

    if (note) row.getCell('note').font = { bold: true, color: { argb: 'FFCC0000' } };

    // Highlight rows for siblings pulled in from another class
    if (isPulledSibling) {
        row.getCell('class').fill = SIBLING_FILL;
        row.getCell('class').font = { bold: true };
    }

    return row;
}

function addSheet(
    wb: ExcelJS.Workbook,
    sheetName: string,
    rows: { student: any; isPulledSibling: boolean }[],
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

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
        cell.fill = HEADER_FILL;
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
    });
    headerRow.height = 20;
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const r of rows) addStudentRow(ws, r.student, feeMap, r.isPulledSibling);
}

/**
 * Builds per-class row sets for one campus, processed smallest class first.
 * When a student's siblings (same family_id) live in a different class, those
 * siblings are pulled into the sibling-group's smallest class sheet instead of
 * appearing in their own class sheet.
 */
function buildCampusClassSheets(campusStudents: any[]) {
    const byFamily = new Map<number, any[]>();
    for (const s of campusStudents) {
        if (s.family_id == null) continue;
        if (!byFamily.has(s.family_id)) byFamily.set(s.family_id, []);
        byFamily.get(s.family_id)!.push(s);
    }

    // Group students by class, ordered by class id ascending (smallest class first)
    const byClass = new Map<number, { order: number; description: string; students: any[] }>();
    for (const s of campusStudents) {
        const classId = s.classes?.id ?? -1;
        const description = s.classes?.description ?? 'Unknown Class';
        if (!byClass.has(classId)) {
            byClass.set(classId, { order: classId === -1 ? Number.MAX_SAFE_INTEGER : classId, description, students: [] });
        }
        byClass.get(classId)!.students.push(s);
    }

    const orderedClasses = Array.from(byClass.values()).sort((a, b) => a.order - b.order);

    const claimed = new Set<number>();
    const sheets: { sheetName: string; rows: { student: any; isPulledSibling: boolean }[] }[] = [];

    for (const classEntry of orderedClasses) {
        const roster = [...classEntry.students].sort((a, b) => a.cc - b.cc);
        const rows: { student: any; isPulledSibling: boolean }[] = [];

        for (const anchor of roster) {
            if (claimed.has(anchor.cc)) continue; // already shown in an earlier (smaller) class sheet

            claimed.add(anchor.cc);
            rows.push({ student: anchor, isPulledSibling: false });

            const familyMembers = anchor.family_id != null ? byFamily.get(anchor.family_id) ?? [] : [];
            const siblings = familyMembers
                .filter(m => m.cc !== anchor.cc && !claimed.has(m.cc))
                .sort((a, b) => a.cc - b.cc);

            for (const sibling of siblings) {
                claimed.add(sibling.cc);
                rows.push({ student: sibling, isPulledSibling: sibling.classes?.id !== classEntry.order });
            }
        }

        if (rows.length > 0) {
            sheets.push({ sheetName: classEntry.description, rows });
        }
    }

    return sheets;
}

async function main() {
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

    console.log(`Students: ${students.length} | Fee rows: ${allFees.length}`);

    const byCampus = new Map<number, any[]>();
    for (const s of students) {
        const cid = s.campus_id ?? 0;
        if (!byCampus.has(cid)) byCampus.set(cid, []);
        byCampus.get(cid)!.push(s);
    }

    for (const campus of campuses) {
        const campusStudents = byCampus.get(campus.id);
        if (!campusStudents || campusStudents.length === 0) {
            console.log(`  ${campus.campus_name}: no enrolled students, skipping`);
            continue;
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = 'TAFS';
        wb.created = new Date();

        const classSheets = buildCampusClassSheets(campusStudents);
        for (const cs of classSheets) {
            const sheetName = cs.sheetName.length > 31 ? cs.sheetName.slice(0, 31) : cs.sheetName;
            addSheet(wb, sheetName, cs.rows, feeMap);
        }

        const safeName = campus.campus_name.replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_');
        const filePath = path.join(OUTPUT_DIR, `${safeName}_fees_may-sep26.xlsx`);
        await wb.xlsx.writeFile(filePath);
        console.log(`  [${campus.campus_name}] ${campusStudents.length} students, ${classSheets.length} class sheets → ${filePath}`);
    }

    console.log('\nDone.');
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
