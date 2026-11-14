import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScopeService } from '../../common/scope/scope.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { createPaginationMeta } from '../../utils/serializer.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
    ColumnMapping,
    MAPPING_FIELDS,
    MappingField,
    RECON_EXCEPTIONS,
    ReconRow,
    ReconStatus,
    SettlementLine,
    TafsTxn,
    dailyTotals,
    guessMapping,
    lineDate,
    normalizeTxnId,
    parseAmount,
    parseSettlementDate,
    pktDate,
    pktDayAfter,
    pktDayStart,
    reconcile,
} from './ubl-reconciliation';
import { UblReconciliationQueryDto } from './dto/ubl-reconciliation.dto';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_RANGE_DAYS = 370;
const HEADER_SCAN_ROWS = 20;

/** rows: cell values; display: the same cells as the file shows them (dates as text). */
type ParsedSheet = { sheetNames: string[]; sheet: string; rows: unknown[][]; display: string[][] };

export type ExportFile = { buffer: Buffer; filename: string; contentType: string };

@Injectable()
export class UblReconciliationService {
    private readonly logger = new Logger(UblReconciliationService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    /**
     * UBL settles to the school's one account, across every campus, so the
     * comparison only means something to someone who sees every campus.
     */
    private assertFullScope(user: IJwtStaffPayload) {
        if (this.scope.isExempt(user)) return;
        const s = this.scope.scopeOf(user as any);
        if (s.campuses.length > 0 || s.classes.length > 0) {
            throw new ForbiddenException('UBL reconciliation covers every campus; it needs access to all campuses.');
        }
    }

    // -----------------------------------------------------------------------
    // Settlement files
    // -----------------------------------------------------------------------

    private readSheet(file: Express.Multer.File | undefined, sheetName?: string): ParsedSheet {
        if (!file?.buffer?.length) throw new BadRequestException('Attach the settlement file (CSV or Excel).');
        if (file.size > MAX_FILE_BYTES) throw new BadRequestException('The file is larger than 10 MB.');
        let wb: XLSX.WorkBook;
        try {
            // raw: a CSV's cells stay text. Otherwise xlsx guesses types month first
            // (12/10/2026 becomes 10 December) and rounds long transaction ids.
            wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: false, raw: true });
        } catch {
            throw new BadRequestException('Could not read the file. Upload a CSV or Excel (.xlsx, .xls) file.');
        }
        const sheet = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
        if (!sheet) throw new BadRequestException('The file has no sheets.');
        // Blank rows are kept so row numbers in messages match the file.
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: true, defval: '', blankrows: true });
        const display = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheet], { header: 1, raw: false, defval: '', blankrows: true });
        return { sheetNames: wb.SheetNames, sheet, rows, display };
    }

    private headersAt(rows: unknown[][], headerRow: number): string[] {
        const row = rows[headerRow - 1] ?? [];
        const seen = new Map<string, number>();
        return row.map((c, i) => {
            let h = String(c ?? '').trim() || `Column ${i + 1}`;
            const n = seen.get(h) ?? 0;
            seen.set(h, n + 1);
            if (n > 0) h = `${h} (${n + 1})`;
            return h;
        });
    }

    /** Banks often put a title block above the table: pick the row that looks most like headers. */
    private detectHeaderRow(rows: unknown[][]): number {
        let best = 1;
        let bestScore = -1;
        for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
            const cells = rows[i].map((c) => String(c ?? '').trim()).filter(Boolean);
            if (cells.length < 2) continue;
            const g = guessMapping(cells);
            const score = (g.transaction_id ? 3 : 0) + (g.amount ? 3 : 0) + (g.transaction_date || g.settlement_date ? 1 : 0)
                + (cells.every((c) => Number.isNaN(Number(c))) ? 1 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = i + 1;
            }
        }
        return best;
    }

    async previewSettlement(file: Express.Multer.File | undefined, user: IJwtStaffPayload, sheet?: string, headerRow?: number) {
        this.assertFullScope(user);
        const parsed = this.readSheet(file, sheet);
        const header_row = headerRow && headerRow >= 1 ? headerRow : this.detectHeaderRow(parsed.rows);
        const headers = this.headersAt(parsed.rows, header_row);
        const body = parsed.rows.slice(header_row);

        // Prefill from the last upload when this file has the same columns.
        const last = await this.prisma.ubl_settlement_imports.findFirst({ orderBy: { id: 'desc' }, select: { column_mapping: true } });
        const lastMapping = (last?.column_mapping ?? null) as ColumnMapping | null;
        const lastFits = lastMapping != null
            && Object.values(lastMapping).every((h) => !h || headers.includes(h))
            && !!lastMapping.transaction_id && !!lastMapping.amount;

        return {
            file_name: file!.originalname,
            sheets: parsed.sheetNames,
            sheet: parsed.sheet,
            header_row,
            headers,
            row_count: body.filter((r) => r.some((c) => String(c ?? '').trim())).length,
            sample_rows: parsed.display
                .slice(header_row)
                .filter((r) => r.some((c) => String(c ?? '').trim()))
                .slice(0, 10)
                .map((r) => headers.map((_, i) => String(r[i] ?? ''))),
            suggested_mapping: lastFits ? lastMapping : guessMapping(headers),
            mapping_source: lastFits ? 'last_upload' : 'guessed',
            fields: MAPPING_FIELDS,
        };
    }

    async importSettlement(
        file: Express.Multer.File | undefined,
        body: { mapping?: string; sheet?: string; header_row?: string | number },
        user: IJwtStaffPayload,
    ) {
        this.assertFullScope(user);
        let mapping: ColumnMapping;
        try {
            mapping = typeof body.mapping === 'string' ? JSON.parse(body.mapping) : (body.mapping ?? {});
        } catch {
            throw new BadRequestException('mapping must be JSON: {"transaction_id": "<column>", "amount": "<column>", ...}');
        }
        const parsed = this.readSheet(file, body.sheet);
        const headerRow = Number(body.header_row) >= 1 ? Number(body.header_row) : this.detectHeaderRow(parsed.rows);
        const headers = this.headersAt(parsed.rows, headerRow);

        const col: Partial<Record<MappingField, number>> = {};
        for (const f of MAPPING_FIELDS) {
            const h = mapping[f.key];
            if (!h) {
                if (f.required) throw new BadRequestException(`Choose the column that holds "${f.label}".`);
                continue;
            }
            const idx = headers.indexOf(h);
            if (idx < 0) throw new BadRequestException(`Column "${h}" is not in row ${headerRow} of sheet "${parsed.sheet}".`);
            col[f.key] = idx;
        }
        if (!col.transaction_date && col.transaction_date !== 0 && !col.settlement_date && col.settlement_date !== 0) {
            throw new BadRequestException('Choose the transaction date or the settlement date column, so lines can be dated.');
        }

        const body_ = parsed.rows.slice(headerRow);
        if (body_.length > MAX_ROWS) throw new BadRequestException(`The file has more than ${MAX_ROWS.toLocaleString()} rows.`);

        type Line = Omit<SettlementLine, 'id' | 'import_id'> & { row_number: number; raw: Record<string, unknown> };
        const lines: Line[] = [];
        const errors: string[] = [];
        let skipped = 0;
        body_.forEach((r, i) => {
            const rowNumber = headerRow + 1 + i;
            if (!r.some((c) => String(c ?? '').trim())) return; // blank line
            const get = (k: MappingField) => (col[k] == null ? undefined : r[col[k]!]);
            const rawId = get('transaction_id');
            if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) {
                errors.push(`Row ${rowNumber}: the transaction id is a number too long for Excel to keep exactly. Format that column as text in the file and export it again.`);
                return;
            }
            const txn = normalizeTxnId(rawId);
            if (!txn) {
                skipped += 1; // blank, subtotal or footer row
                return;
            }
            const amount = parseAmount(get('amount'));
            if (amount == null) {
                errors.push(`Row ${rowNumber}: amount "${String(get('amount') ?? '')}" is not a number.`);
                return;
            }
            const tDate = col.transaction_date == null ? null : parseSettlementDate(get('transaction_date'));
            const sDate = col.settlement_date == null ? null : parseSettlementDate(get('settlement_date'));
            if (col.transaction_date != null && String(get('transaction_date') ?? '').trim() && !tDate) {
                errors.push(`Row ${rowNumber}: transaction date "${String(get('transaction_date'))}" is not a date.`);
                return;
            }
            if (col.settlement_date != null && String(get('settlement_date') ?? '').trim() && !sDate) {
                errors.push(`Row ${rowNumber}: settlement date "${String(get('settlement_date'))}" is not a date.`);
                return;
            }
            if (!tDate && !sDate) {
                errors.push(`Row ${rowNumber}: no date.`);
                return;
            }
            if (txn.length > 100) {
                errors.push(`Row ${rowNumber}: transaction id longer than 100 characters.`);
                return;
            }
            lines.push({
                row_number: rowNumber,
                transaction_id: txn,
                amount,
                transaction_date: tDate,
                settlement_date: sDate,
                channel: col.channel == null ? null : String(get('channel') ?? '').trim().slice(0, 50) || null,
                consumer_number: col.consumer_number == null ? null : String(get('consumer_number') ?? '').trim().slice(0, 30) || null,
                raw: Object.fromEntries(headers.map((h, j) => [h, r[j] ?? ''])),
            });
        });

        if (errors.length) {
            throw new BadRequestException({
                message: `${errors.length} row(s) could not be read; nothing was imported. ${errors.slice(0, 5).join(' ')}`,
                errors: errors.slice(0, 50),
            });
        }
        if (!lines.length) throw new BadRequestException('No transaction lines found under the header row.');

        const dates = lines.map(lineDate).filter(Boolean).sort() as string[];
        const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        const ids = [...new Set(lines.map((l) => l.transaction_id))];
        const alreadyImported = await this.prisma.ubl_settlement_lines.count({ where: { transaction_id: { in: ids } } });
        const actor = auditActorLabel(user.username);

        const imp = await this.prisma.$transaction(async (tx) => {
            const created = await tx.ubl_settlement_imports.create({
                data: {
                    file_name: (file!.originalname || 'settlement').slice(0, 255),
                    sheet_name: parsed.sheet.slice(0, 100),
                    uploaded_by: actor.slice(0, 100),
                    column_mapping: mapping as any,
                    row_count: lines.length,
                    skipped_rows: skipped,
                    total_amount: total,
                    first_date: dates.length ? new Date(`${dates[0]}T00:00:00Z`) : null,
                    last_date: dates.length ? new Date(`${dates[dates.length - 1]}T00:00:00Z`) : null,
                },
            });
            for (let i = 0; i < lines.length; i += 1000) {
                await tx.ubl_settlement_lines.createMany({
                    data: lines.slice(i, i + 1000).map((l) => ({
                        import_id: created.id,
                        row_number: l.row_number,
                        transaction_id: l.transaction_id,
                        amount: l.amount,
                        transaction_date: l.transaction_date ? new Date(`${l.transaction_date}T00:00:00Z`) : null,
                        settlement_date: l.settlement_date ? new Date(`${l.settlement_date}T00:00:00Z`) : null,
                        channel: l.channel,
                        consumer_number: l.consumer_number,
                        raw: l.raw as any,
                    })),
                });
            }
            return created;
        });

        await this.auditLogs.log({
            entity_type: 'UBL_SETTLEMENT',
            entity_id: String(imp.id),
            action: 'CREATED',
            changed_by: actor,
            note: `Imported UBL settlement "${imp.file_name}": ${lines.length} lines, Rs. ${total.toLocaleString('en-PK')}, ${dates[0] ?? '?'} to ${dates[dates.length - 1] ?? '?'}.`,
        }).catch((err) => this.logger.warn(`audit log failed: ${err?.message ?? err}`));

        return {
            ...this.mapImport(imp),
            already_imported_lines: alreadyImported,
        };
    }

    private mapImport(i: any) {
        return {
            id: i.id,
            file_name: i.file_name,
            sheet_name: i.sheet_name,
            uploaded_by: i.uploaded_by,
            uploaded_at: i.uploaded_at,
            row_count: i.row_count,
            skipped_rows: i.skipped_rows,
            total_amount: Number(i.total_amount),
            first_date: i.first_date ? new Date(i.first_date).toISOString().slice(0, 10) : null,
            last_date: i.last_date ? new Date(i.last_date).toISOString().slice(0, 10) : null,
            column_mapping: i.column_mapping,
        };
    }

    async listImports(user: IJwtStaffPayload) {
        this.assertFullScope(user);
        const rows = await this.prisma.ubl_settlement_imports.findMany({ orderBy: { id: 'desc' }, take: 200 });
        return rows.map((r) => this.mapImport(r));
    }

    async deleteImport(id: number, user: IJwtStaffPayload) {
        this.assertFullScope(user);
        const imp = await this.prisma.ubl_settlement_imports.findUnique({ where: { id } });
        if (!imp) throw new NotFoundException('Settlement upload not found');
        await this.prisma.ubl_settlement_imports.delete({ where: { id } });
        await this.auditLogs.log({
            entity_type: 'UBL_SETTLEMENT',
            entity_id: String(id),
            action: 'DELETED',
            changed_by: auditActorLabel(user.username),
            note: `Removed UBL settlement upload "${imp.file_name}" (${imp.row_count} lines, Rs. ${Number(imp.total_amount).toLocaleString('en-PK')}).`,
        }).catch((err) => this.logger.warn(`audit log failed: ${err?.message ?? err}`));
        return { id };
    }

    // -----------------------------------------------------------------------
    // Reconciliation
    // -----------------------------------------------------------------------

    private assertRange(q: UblReconciliationQueryDto) {
        if (q.from_date > q.to_date) throw new BadRequestException('from_date must be on or before to_date');
        const days = (pktDayStart(q.to_date).getTime() - pktDayStart(q.from_date).getTime()) / 86_400_000;
        if (days > MAX_RANGE_DAYS) throw new BadRequestException('Choose a range of at most a year.');
    }

    /** Both sides for the range, plus whatever the other side matches outside it. */
    private async load(q: UblReconciliationQueryDto) {
        const fromDay = new Date(`${q.from_date}T00:00:00Z`);
        const toDay = new Date(`${q.to_date}T00:00:00Z`);
        const lineInRange = {
            OR: [
                { transaction_date: { gte: fromDay, lte: toDay } },
                { transaction_date: null, settlement_date: { gte: fromDay, lte: toDay } },
            ],
        };
        const [tafsRaw, linesRaw] = await Promise.all([
            this.prisma.ubl_transactions.findMany({
                where: { transaction_at: { gte: pktDayStart(q.from_date), lt: pktDayAfter(q.to_date) } },
            }),
            this.prisma.ubl_settlement_lines.findMany({ where: lineInRange }),
        ]);
        const tafsIds = new Set(tafsRaw.map((t) => t.transaction_id));
        const lineIds = new Set(linesRaw.map((l) => l.transaction_id));
        const [moreLines, moreTafs] = await Promise.all([
            tafsIds.size
                ? this.prisma.ubl_settlement_lines.findMany({ where: { transaction_id: { in: [...tafsIds] }, NOT: lineInRange } })
                : Promise.resolve([]),
            lineIds.size
                ? this.prisma.ubl_transactions.findMany({
                    where: { transaction_id: { in: [...lineIds].filter((id) => !tafsIds.has(id)) } },
                })
                : Promise.resolve([]),
        ]);
        const allTafs = [...tafsRaw, ...moreTafs];

        const depositIds = allTafs.map((t) => t.deposit_id).filter((d): d is number => d != null);
        const ccs = [...new Set(allTafs.map((t) => t.student_id))];
        const [deposits, students] = await Promise.all([
            depositIds.length
                ? this.prisma.deposits.findMany({ where: { id: { in: depositIds } }, select: { id: true } })
                : Promise.resolve([]),
            ccs.length
                ? this.prisma.students.findMany({
                    where: { cc: { in: ccs } },
                    select: { cc: true, full_name: true, campuses: { select: { campus_name: true } } },
                })
                : Promise.resolve([]),
        ]);
        const live = new Set(deposits.map((d) => d.id));
        type StudentRow = { cc: number; full_name: string; campuses: { campus_name: string } | null };
        const studentBy = new Map<number, StudentRow>((students as StudentRow[]).map((s) => [s.cc, s]));

        const toTafs = (t: (typeof allTafs)[number]): TafsTxn => ({
            transaction_id: t.transaction_id,
            student_id: t.student_id,
            student_name: studentBy.get(t.student_id)?.full_name ?? null,
            campus: studentBy.get(t.student_id)?.campuses?.campus_name ?? null,
            consumer_number: t.consumer_number,
            voucher_number: t.voucher_number,
            channel: t.channel,
            payment_method: t.payment_method,
            amount_received: Number(t.amount_received),
            amount_booked: Number(t.amount_booked),
            channel_fee: Number(t.channel_fee),
            transaction_at: t.transaction_at,
            deposit_id: t.deposit_id,
            deposit_exists: t.deposit_id != null && live.has(t.deposit_id),
        });
        const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
        const toLine = (l: (typeof linesRaw)[number]): SettlementLine => ({
            id: l.id,
            import_id: l.import_id,
            transaction_id: l.transaction_id,
            amount: Number(l.amount),
            transaction_date: day(l.transaction_date),
            settlement_date: day(l.settlement_date),
            channel: l.channel,
            consumer_number: l.consumer_number,
        });
        return {
            tafs: allTafs.map(toTafs),
            lines: [...linesRaw, ...moreLines].map(toLine),
        };
    }

    private async compute(q: UblReconciliationQueryDto) {
        this.assertRange(q);
        const { tafs, lines } = await this.load(q);
        const rows = reconcile(tafs, lines);
        const daily = dailyTotals(tafs, lines, q.from_date, q.to_date);

        const round = (n: number) => Math.round(n * 100) / 100;
        const inRangeTafs = tafs.filter((t) => {
            const d = pktDate(t.transaction_at);
            return d >= q.from_date && d <= q.to_date;
        });
        const inRangeLines = lines.filter((l) => {
            const d = lineDate(l);
            return d != null && d >= q.from_date && d <= q.to_date;
        });
        const posted = inRangeTafs.filter((t) => t.deposit_exists);
        const reversed = inRangeTafs.filter((t) => !t.deposit_exists);
        const statusCounts = Object.fromEntries(
            ['MATCHED', 'AMOUNT_DIFFERS', 'DUPLICATE_IN_SETTLEMENT', 'NOT_SETTLED', 'NOT_AT_TAFS', 'REVERSED_BUT_SETTLED', 'REVERSED_NOT_SETTLED']
                .map((s) => [s, rows.filter((r) => r.status === s).length]),
        ) as Record<ReconStatus, number>;
        const totals = {
            tafs_count: posted.length,
            tafs_booked: round(posted.reduce((s, t) => s + t.amount_booked, 0)),
            tafs_received: round(posted.reduce((s, t) => s + t.amount_received, 0)),
            tafs_channel_fee: round(posted.reduce((s, t) => s + t.channel_fee, 0)),
            reversed_count: reversed.length,
            reversed_booked: round(reversed.reduce((s, t) => s + t.amount_booked, 0)),
            ubl_count: inRangeLines.length,
            ubl_amount: round(inRangeLines.reduce((s, l) => s + l.amount, 0)),
            difference: 0,
            status_counts: statusCounts,
            exceptions: rows.filter((r) => RECON_EXCEPTIONS.has(r.status)).length,
        };
        totals.difference = round(totals.ubl_amount - totals.tafs_booked);

        let filtered = rows;
        if (q.status?.length) {
            const want = new Set<string>(q.status.flatMap((s) => (s === 'EXCEPTIONS' ? [...RECON_EXCEPTIONS] : [s])));
            filtered = filtered.filter((r) => want.has(r.status));
        }
        if (q.channel?.length) {
            const want = new Set(q.channel.map((c) => c.toUpperCase()));
            filtered = filtered.filter((r) => want.has((r.channel ?? 'UNKNOWN').toUpperCase()));
        }
        const term = q.q?.trim().toLowerCase();
        if (term) {
            filtered = filtered.filter((r) =>
                [
                    r.transaction_id,
                    r.tafs?.consumer_number,
                    r.tafs?.student_name,
                    r.tafs ? String(r.tafs.student_id) : null,
                    r.tafs?.voucher_number,
                    r.tafs?.deposit_id != null ? String(r.tafs.deposit_id) : null,
                ].some((v) => v != null && v.toLowerCase().includes(term)),
            );
        }
        return { rows: filtered, totals, daily };
    }

    private mapRow(r: ReconRow) {
        return {
            transaction_id: r.transaction_id,
            status: r.status,
            date: r.date,
            channel: r.channel,
            cc: r.tafs?.student_id ?? null,
            student_name: r.tafs?.student_name ?? null,
            campus: r.tafs?.campus ?? null,
            consumer_number: r.tafs?.consumer_number ?? null,
            voucher_number: r.tafs?.voucher_number ?? null,
            payment_method: r.tafs?.payment_method ?? null,
            transaction_at: r.tafs?.transaction_at ?? null,
            tafs_received: r.tafs ? r.tafs.amount_received : null,
            tafs_booked: r.tafs ? r.tafs.amount_booked : null,
            channel_fee: r.tafs ? r.tafs.channel_fee : null,
            deposit_id: r.tafs?.deposit_id ?? null,
            deposit_reversed: r.tafs ? !r.tafs.deposit_exists : null,
            ubl_amount: r.ubl?.amount ?? null,
            ubl_count: r.ubl?.count ?? 0,
            ubl_transaction_date: r.ubl?.transaction_date ?? null,
            ubl_settlement_date: r.ubl?.settlement_date ?? null,
            ubl_import_ids: r.ubl?.import_ids ?? [],
            expected: r.expected,
            difference: r.difference,
            note: r.note,
        };
    }

    async reconciliation(q: UblReconciliationQueryDto, user: IJwtStaffPayload) {
        this.assertFullScope(user);
        const { rows, totals, daily } = await this.compute(q);
        const page = q.page ?? 1;
        const limit = Math.min(q.limit ?? 50, 200);
        return {
            items: rows.slice((page - 1) * limit, page * limit).map((r) => this.mapRow(r)),
            pagination: createPaginationMeta(page, limit, rows.length),
            totals,
            daily,
        };
    }

    async exportReconciliation(q: UblReconciliationQueryDto, user: IJwtStaffPayload): Promise<ExportFile> {
        this.assertFullScope(user);
        const { rows, totals, daily } = await this.compute(q);
        const wb = new ExcelJS.Workbook();
        wb.creator = 'TAFS';
        const bold = { font: { bold: true } };
        const money = '#,##0.00';

        const s = wb.addWorksheet('Summary');
        s.addRow([`UBL collections reconciliation, ${q.from_date} to ${q.to_date}`]).font = { bold: true, size: 13 };
        s.addRow([]);
        const summary: [string, number][] = [
            ['Payments booked at TAFS', totals.tafs_count],
            ['Amount booked at TAFS (expected settlement)', totals.tafs_booked],
            ['Collected from payers (incl. 1Bill charges)', totals.tafs_received],
            ['1Bill charges (kept by 1Bill)', totals.tafs_channel_fee],
            ['Payments reversed at TAFS', totals.reversed_count],
            ['Lines settled by UBL', totals.ubl_count],
            ['Amount settled by UBL', totals.ubl_amount],
            ['Difference (UBL minus TAFS)', totals.difference],
        ];
        for (const [k, v] of summary) s.addRow([k, v]);
        s.addRow([]);
        s.addRow(['Status', 'Transactions']).eachCell((c) => Object.assign(c, bold));
        for (const [k, v] of Object.entries(totals.status_counts)) s.addRow([STATUS_LABEL[k as ReconStatus] ?? k, v]);
        s.addRow([]);
        s.addRow(['Date', 'Channel', 'TAFS count', 'TAFS amount', 'UBL count', 'UBL amount', 'Difference'])
            .eachCell((c) => Object.assign(c, bold));
        for (const d of daily) s.addRow([d.date, d.channel, d.tafs_count, d.tafs_amount, d.ubl_count, d.ubl_amount, d.difference]);
        s.getColumn(1).width = 44;
        for (const c of [2, 3, 4, 5, 6, 7]) s.getColumn(c).width = 16;
        for (const c of [4, 6, 7]) s.getColumn(c).numFmt = money;

        const t = wb.addWorksheet('Transactions');
        const cols: [string, number][] = [
            ['Status', 26], ['Date', 12], ['UBL transaction id', 28], ['Channel', 16], ['Method', 16], ['CC', 8],
            ['Student', 28], ['Campus', 22], ['Voucher', 14], ['TAFS receipt', 12], ['Collected', 14], ['1Bill charge', 12],
            ['Booked (expected)', 16], ['UBL settled', 14], ['Difference', 14], ['UBL txn date', 13], ['UBL settlement date', 16], ['Note', 40],
        ];
        t.columns = cols.map(([header, width]) => ({ header, width }));
        t.getRow(1).font = { bold: true };
        for (const r of rows.map((x) => this.mapRow(x))) {
            t.addRow([
                STATUS_LABEL[r.status], r.date, r.transaction_id, r.channel, r.payment_method, r.cc, r.student_name, r.campus,
                r.voucher_number, r.deposit_id, r.tafs_received, r.channel_fee, r.expected, r.ubl_amount, r.difference,
                r.ubl_transaction_date, r.ubl_settlement_date,
                [r.deposit_reversed ? 'Reversed at TAFS' : null, r.note].filter(Boolean).join('; ') || null,
            ]);
        }
        for (const c of [11, 12, 13, 14, 15]) t.getColumn(c).numFmt = money;
        t.views = [{ state: 'frozen', ySplit: 1 }];

        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        return {
            buffer,
            filename: `ubl-reconciliation-${q.from_date}-to-${q.to_date}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
    }
}

export const STATUS_LABEL: Record<ReconStatus, string> = {
    MATCHED: 'Matched',
    AMOUNT_DIFFERS: 'Amount differs',
    DUPLICATE_IN_SETTLEMENT: 'Settled more than once',
    NOT_SETTLED: 'Not in UBL settlement',
    NOT_AT_TAFS: 'Not booked at TAFS',
    REVERSED_BUT_SETTLED: 'Reversed at TAFS, settled by UBL',
    REVERSED_NOT_SETTLED: 'Reversed at TAFS, not settled',
};
