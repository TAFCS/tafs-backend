/**
 * UBL settlement reconciliation: pure matching and parsing, no database.
 *
 * TAFS's side is ubl_transactions (every payment UBL posted). UBL's side is the
 * settlement statement UBL sends, uploaded as ubl_settlement_lines. The two are
 * matched on UBL's transaction id. What TAFS expects UBL to settle for a payment
 * is amount_booked: the fee amount. On 1Bill the payer's charge stays with 1Bill
 * (TAFS API Documentation for UBL), so it is never part of the settlement.
 */

export const RECON_STATUSES = [
    /** In both, and UBL settled exactly what TAFS booked. */
    'MATCHED',
    /** In both, but the settled amount differs from what TAFS booked. */
    'AMOUNT_DIFFERS',
    /** UBL settled the same transaction id more than once. */
    'DUPLICATE_IN_SETTLEMENT',
    /** TAFS booked it; UBL has not settled it (yet). */
    'NOT_SETTLED',
    /** UBL settled it; TAFS has no record of the payment. */
    'NOT_AT_TAFS',
    /** TAFS reversed the payment, but UBL settled it: money without a booking. */
    'REVERSED_BUT_SETTLED',
    /** TAFS reversed the payment and UBL did not settle it. Nothing owed either way. */
    'REVERSED_NOT_SETTLED',
] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

/** Statuses that need someone to look at them. */
export const RECON_EXCEPTIONS: ReadonlySet<ReconStatus> = new Set([
    'AMOUNT_DIFFERS',
    'DUPLICATE_IN_SETTLEMENT',
    'NOT_SETTLED',
    'NOT_AT_TAFS',
    'REVERSED_BUT_SETTLED',
]);

export type TafsTxn = {
    transaction_id: string;
    student_id: number;
    student_name: string | null;
    campus: string | null;
    consumer_number: string | null;
    voucher_number: string | null;
    channel: string;
    payment_method: string;
    amount_received: number;
    amount_booked: number;
    channel_fee: number;
    transaction_at: Date;
    deposit_id: number | null;
    /** False once the deposit has been reversed (deleted) at TAFS. */
    deposit_exists: boolean;
};

export type SettlementLine = {
    id: number;
    import_id: number;
    transaction_id: string;
    amount: number;
    /** YYYY-MM-DD */
    transaction_date: string | null;
    /** YYYY-MM-DD */
    settlement_date: string | null;
    channel: string | null;
    consumer_number: string | null;
};

export type ReconRow = {
    transaction_id: string;
    status: ReconStatus;
    /** TAFS's transaction date (PKT) when TAFS has it, else UBL's line date. */
    date: string | null;
    channel: string | null;
    tafs: TafsTxn | null;
    ubl: {
        count: number;
        amount: number;
        transaction_date: string | null;
        settlement_date: string | null;
        import_ids: number[];
    } | null;
    /** What TAFS expects UBL to settle; 0 for a reversed payment or one TAFS has no record of. */
    expected: number;
    /** UBL settled minus expected. */
    difference: number;
    note: string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** YYYY-MM-DD of an instant in Pakistan time. */
export function pktDate(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(d);
}

/** Start of a PKT calendar day, and the start of the day after it. */
export function pktDayStart(ymd: string): Date {
    return new Date(`${ymd}T00:00:00+05:00`);
}
export function pktDayAfter(ymd: string): Date {
    const d = pktDayStart(ymd);
    return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}

/** UBL's transaction id as it should be compared: trimmed, Excel's text marker dropped. */
export function normalizeTxnId(v: unknown): string {
    return String(v ?? '').trim().replace(/^'+/, '').trim();
}

export const lineDate = (l: Pick<SettlementLine, 'transaction_date' | 'settlement_date'>) =>
    l.transaction_date ?? l.settlement_date;

/** One row per transaction id across both sides. */
export function reconcile(tafsTxns: TafsTxn[], lines: SettlementLine[]): ReconRow[] {
    const byId = new Map<string, { tafs: TafsTxn | null; lines: SettlementLine[] }>();
    for (const t of tafsTxns) {
        byId.set(t.transaction_id, { tafs: t, lines: byId.get(t.transaction_id)?.lines ?? [] });
    }
    for (const l of lines) {
        const entry = byId.get(l.transaction_id) ?? { tafs: null, lines: [] };
        if (!entry.lines.some((x) => x.id === l.id)) entry.lines.push(l);
        byId.set(l.transaction_id, entry);
    }

    const rows: ReconRow[] = [];
    for (const [transaction_id, { tafs, lines: ls }] of byId) {
        const settled = round2(ls.reduce((s, l) => s + l.amount, 0));
        const ubl = ls.length
            ? {
                count: ls.length,
                amount: settled,
                transaction_date: ls.map((l) => l.transaction_date).find(Boolean) ?? null,
                settlement_date: ls.map((l) => l.settlement_date).find(Boolean) ?? null,
                import_ids: [...new Set(ls.map((l) => l.import_id))].sort((a, b) => a - b),
            }
            : null;
        const live = tafs != null && tafs.deposit_exists;
        const expected = live ? round2(tafs.amount_booked) : 0;

        let status: ReconStatus;
        let note: string | null = null;
        if (!tafs) {
            status = 'NOT_AT_TAFS';
            if (ls.length > 1) note = `Settled ${ls.length} times`;
        } else if (!tafs.deposit_exists) {
            status = ls.length ? 'REVERSED_BUT_SETTLED' : 'REVERSED_NOT_SETTLED';
        } else if (!ls.length) {
            status = 'NOT_SETTLED';
        } else if (ls.length > 1) {
            status = 'DUPLICATE_IN_SETTLEMENT';
            note = `Settled ${ls.length} times`;
        } else if (settled === expected) {
            status = 'MATCHED';
        } else {
            status = 'AMOUNT_DIFFERS';
            if (tafs.channel_fee > 0 && settled === round2(tafs.amount_received)) {
                note = 'UBL settled the amount including the 1Bill charge';
            }
        }

        rows.push({
            transaction_id,
            status,
            date: tafs ? pktDate(tafs.transaction_at) : (ls.map(lineDate).find(Boolean) ?? null),
            channel: tafs?.channel ?? ls.map((l) => l.channel).find(Boolean) ?? null,
            tafs,
            ubl,
            expected,
            difference: round2(settled - expected),
            note,
        });
    }

    return rows.sort(
        (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.transaction_id.localeCompare(b.transaction_id),
    );
}

export type DailyTotal = {
    date: string;
    channel: string;
    tafs_count: number;
    tafs_amount: number;
    ubl_count: number;
    ubl_amount: number;
    difference: number;
};

/**
 * Per day and channel: what TAFS booked (reversed payments left out) against
 * what UBL settled, each dated on its own side. A payment booked late one
 * evening and settled the next day shows as a difference on both days.
 */
export function dailyTotals(
    tafsTxns: TafsTxn[],
    lines: SettlementLine[],
    from: string,
    to: string,
): DailyTotal[] {
    const map = new Map<string, DailyTotal>();
    const get = (date: string, channel: string) => {
        const key = `${date}|${channel}`;
        let row = map.get(key);
        if (!row) {
            row = { date, channel, tafs_count: 0, tafs_amount: 0, ubl_count: 0, ubl_amount: 0, difference: 0 };
            map.set(key, row);
        }
        return row;
    };
    for (const t of tafsTxns) {
        if (!t.deposit_exists) continue;
        const date = pktDate(t.transaction_at);
        if (date < from || date > to) continue;
        const row = get(date, t.channel);
        row.tafs_count += 1;
        row.tafs_amount = round2(row.tafs_amount + t.amount_booked);
    }
    const tafsChannel = new Map(tafsTxns.map((t) => [t.transaction_id, t.channel]));
    for (const l of lines) {
        const date = lineDate(l);
        if (!date || date < from || date > to) continue;
        // File the line under TAFS's channel name when TAFS knows the payment,
        // so the two sides of one channel land on one row.
        const row = get(date, tafsChannel.get(l.transaction_id) ?? (l.channel?.trim().toUpperCase() || 'UNKNOWN'));
        row.ubl_count += 1;
        row.ubl_amount = round2(row.ubl_amount + l.amount);
    }
    for (const row of map.values()) row.difference = round2(row.ubl_amount - row.tafs_amount);
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel));
}

// ---------------------------------------------------------------------------
// Settlement file parsing
// ---------------------------------------------------------------------------

export const MAPPING_FIELDS = [
    { key: 'transaction_id', label: 'UBL transaction id', required: true },
    { key: 'amount', label: 'Amount', required: true },
    { key: 'transaction_date', label: 'Transaction date', required: false },
    { key: 'settlement_date', label: 'Settlement date', required: false },
    { key: 'channel', label: 'Channel', required: false },
    { key: 'consumer_number', label: 'Consumer number / CC', required: false },
] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number]['key'];
/** Field -> the file's column header. */
export type ColumnMapping = Partial<Record<MappingField, string>>;

const GUESSES: Record<MappingField, RegExp[]> = {
    transaction_id: [
        /^(ubl\s*)?(txn|trans(action)?)\.?\s*(id|ref(erence)?|no\.?|number|#)$/i,
        /^(rrn|stan|ref(erence)?\s*(id|no\.?|number)?|tran\s*id)$/i,
        /(txn|trans(action)?).*(id|ref|no)/i,
    ],
    amount: [/^(txn\s*|transaction\s*|settled?\s*|credit\s*)?(amount|amt)(\s*\((pkr|rs\.?)\))?$/i, /amount|amt/i],
    transaction_date: [/^(txn|trans(action)?|value|payment|posting)\s*date/i, /^date$/i],
    settlement_date: [/settle/i],
    channel: [/^channel/i, /channel|mode/i],
    consumer_number: [/consumer|customer|bill\s*(no|number|ref)|^cc\b|student/i],
};

/** Best guess of which header holds each field. A header is used once. */
export function guessMapping(headers: string[]): ColumnMapping {
    const mapping: ColumnMapping = {};
    const used = new Set<string>();
    for (const field of MAPPING_FIELDS.map((f) => f.key)) {
        for (const re of GUESSES[field]) {
            const hit = headers.find((h) => h && !used.has(h) && re.test(h.trim()));
            if (hit) {
                mapping[field] = hit;
                used.add(hit);
                break;
            }
        }
    }
    return mapping;
}

/** "1,234.50", "PKR 1,234", "Rs. 500", "(100)", 1234 → number; anything else → null. */
export function parseAmount(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
    let s = String(v ?? '').trim();
    if (!s) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) {
        negative = true;
        s = s.slice(1, -1);
    }
    s = s.replace(/(pkr|rs\.?)/gi, '').replace(/[,\s]/g, '');
    if (s.endsWith('-')) {
        negative = true;
        s = s.slice(0, -1);
    }
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return round2(negative ? -n : n);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymd(y: number, m: number, d: number): string | null {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) return null;
    return date.toISOString().slice(0, 10);
}

/**
 * A settlement date as YYYY-MM-DD. Numeric dates are read day first
 * (12/10/2026 is 12 October), as Pakistani banks write them. Accepts a Date
 * (from an Excel date cell), an Excel serial number, ISO, YYYYMMDD,
 * DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY and DD-MMM-YYYY, with or without a time.
 */
export function parseSettlementDate(v: unknown): string | null {
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return null;
        // Excel dates have no zone; xlsx hands them over at local midnight-ish,
        // so read the calendar date in PKT, not UTC.
        return pktDate(new Date(v.getTime() + 60 * 1000));
    }
    if (typeof v === 'number') {
        if (v > 20000 && v < 80000) {
            // The serial's whole part is the calendar day; any fraction is a time of day.
            const ms = (Math.floor(v) - 25569) * 86400 * 1000;
            return new Date(ms).toISOString().slice(0, 10);
        }
        if (v >= 20000101 && v <= 21001231) return parseSettlementDate(String(v));
        return null;
    }
    const s = String(v ?? '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{6})?$/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) return ymd(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})[\s/.-]([a-z]{3})[a-z]*[\s/.,-]+(\d{2,4})/i);
    if (m) {
        const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
        return month ? ymd(+m[3], month, +m[1]) : null;
    }
    return null;
}
