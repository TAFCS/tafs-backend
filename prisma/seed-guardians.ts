/**
 * Seed script: inserts guardians and links them to students from parents_data CSV.
 *
 * CSV columns:
 *   cc              - student's cc number (references students table)
 *   full_name       - guardian's full name
 *   fathers_name    - father's name (used as full_name if available)
 *   father_cnic     - father's CNIC
 *   mother_cnic     - mother's CNIC
 *   campus_id       - campus ID
 *
 * Rules:
 *   - If full_name is empty, use fathers_name
 *   - If father_cnic exists, create a guardian record for the father as PRIMARY_CONTACT
 *   - If mother_cnic exists, create a guardian record for the mother
 *   - Link guardians to students via student_guardians table
 *   - Use upsert to handle duplicates (by CNIC)
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validates a CNIC format (Pakistan): XXXXX-XXXXXXX-X
 */
function isValidCnic(cnic: string): boolean {
    return /^\d{5}-\d{7}-\d{1}$/.test(cnic.trim());
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const csvPath = path.resolve(
        '/Users/macbook/Downloads/gkf_and_nnn_parents - gkf_parents_merged.csv.csv',
    );

    if (!fs.existsSync(csvPath)) {
        throw new Error(`CSV not found at: ${csvPath}`);
    }

    const raw = fs.readFileSync(csvPath, 'utf-8');
    const records: Array<Record<string, string>> = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });

    console.log(`Parsed ${records.length} rows from gkf_parents_merged.csv`);

    let guardianCreated = 0;
    let guardianSkipped = 0;
    let studentGuardianLinked = 0;
    let errors = 0;

    for (const row of records) {
        const cc = parseInt(row['cc'], 10);
        const guardianName = row['full_name']?.trim() || row['fathers_name']?.trim();
        const fatherCnic = row['father_cnic']?.trim() || '';
        const motherCnic = row['mother_cnic']?.trim() || '';

        if (!cc || isNaN(cc)) {
            console.warn(`  SKIP – invalid cc: ${JSON.stringify(row)}`);
            guardianSkipped++;
            continue;
        }

        // Verify student exists
        try {
            const student = await prisma.students.findUnique({
                where: { cc },
            });

            if (!student) {
                console.warn(`  WARN – student cc=${cc} not found in students table`);
                guardianSkipped++;
                continue;
            }
        } catch (e) {
            console.error(`  ERROR verifying student cc=${cc}:`, e);
            errors++;
            continue;
        }

        // Process father (if CNIC is valid)
        if (fatherCnic && isValidCnic(fatherCnic)) {
            try {
                const fatherName = row['fathers_name']?.trim() || guardianName || `Guardian (CC: ${cc})`;
                const guardian = await prisma.guardians.upsert({
                    where: { cnic: fatherCnic },
                    update: {},
                    create: {
                        cnic: fatherCnic,
                        full_name: fatherName,
                    },
                });

                // Link to student
                await prisma.student_guardians.upsert({
                    where: {
                        student_id_guardian_id: {
                            student_id: cc,
                            guardian_id: guardian.id,
                        },
                    },
                    update: {
                        is_primary_contact: true,
                    },
                    create: {
                        student_id: cc,
                        guardian_id: guardian.id,
                        relationship: 'FATHER',
                        is_primary_contact: true,
                    },
                });

                guardianCreated++;
                studentGuardianLinked++;
            } catch (e) {
                console.error(`  ERROR processing father for cc=${cc}:`, e);
                errors++;
            }
        }

        // Process mother (if CNIC is valid)
        if (motherCnic && isValidCnic(motherCnic)) {
            try {
                const motherName = `Mother (CC: ${cc})`;
                const guardian = await prisma.guardians.upsert({
                    where: { cnic: motherCnic },
                    update: {},
                    create: {
                        cnic: motherCnic,
                        full_name: motherName,
                    },
                });

                // Link to student
                await prisma.student_guardians.upsert({
                    where: {
                        student_id_guardian_id: {
                            student_id: cc,
                            guardian_id: guardian.id,
                        },
                    },
                    update: {},
                    create: {
                        student_id: cc,
                        guardian_id: guardian.id,
                        relationship: 'MOTHER',
                        is_primary_contact: false,
                    },
                });

                guardianCreated++;
                studentGuardianLinked++;
            } catch (e) {
                console.error(`  ERROR processing mother for cc=${cc}:`, e);
                errors++;
            }
        }

        if ((guardianCreated + guardianSkipped) % 100 === 0 && guardianCreated > 0) {
            console.log(
                `  ...processed ${guardianCreated + guardianSkipped} records so far (created: ${guardianCreated})`,
            );
        }
    }

    console.log(`
Done. 
  Guardians created/linked: ${guardianCreated}
  Skipped: ${guardianSkipped}
  Errors: ${errors}
  Total student-guardian links created: ${studentGuardianLinked}
`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
