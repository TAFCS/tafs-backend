/**
 * TAFSD-510: load the school's five December 2026 schedules (Campus II, GEJ) as
 * DRAFT exam schedules, through ExamDocumentsService so they pass the same
 * validation as the screen. Staff check them in Exam Documents and publish.
 *
 * Dry run by default (prints what it would create). Skips a schedule that
 * already exists (same campus, year, title and line under the title).
 *   npx ts-node --transpile-only scripts/seed-exam-schedules-dec-2026.ts            # dry run
 *   npx ts-node --transpile-only scripts/seed-exam-schedules-dec-2026.ts --apply    # write
 * Needs the 20261113120000_exam_schedules_and_documents migration applied.
 */
/* eslint-disable */
import { PrismaClient } from '@prisma/client';
import { ExamDocumentsService } from '../src/modules/exam-documents/exam-documents.service';
import { ScopeService } from '../src/common/scope/scope.service';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { DEC_2026_SCHEDULES, toUpsertBody } from './data/exam-schedules-dec-2026';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient({ log: [] });
const storage = { extractKeyFromUrl: (u: string) => u, getFile: async () => { throw new Error('not used'); } } as any;
const svc = new ExamDocumentsService(prisma as any, new ScopeService(prisma as any), new AuditLogsService(prisma as any), storage);
const SEED_USER = { role: 'SUPER_ADMIN', username: 'seed:TAFSD-510', sub: 0 } as any;

async function main() {
    const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against ${host}`);
    for (const seed of DEC_2026_SCHEDULES) {
        const body = toUpsertBody(seed);
        const exists = await prisma.exam_schedules.findFirst({
            where: { campus_id: body.campus_id, academic_year: body.academic_year, title: body.title, segment_line: body.segment_line },
            select: { id: true },
        });
        const summary = `${body.title} / ${body.segment_line}: ${body.class_ids.length} classes, ${body.papers.length} papers, ${body.notes.length} notes`;
        if (exists) {
            console.log(`  skip   ${summary} (already schedule #${exists.id})`);
            continue;
        }
        if (!APPLY) {
            console.log(`  would  ${summary}`);
            continue;
        }
        const created = await svc.createSchedule(body as any, SEED_USER);
        console.log(`  made   #${created.id} ${summary}`);
    }
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
