import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface ParsedAttLog {
    pin: string;
    scanTime: Date;
    status?: string;
    verify?: string;
    workCode?: string;
}

function parseDeviceDateTime(s: string | undefined): Date | null {
    const m = s?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
}

function startOfUTCDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseAttLogLines(body: string): ParsedAttLog[] {
    const rows: ParsedAttLog[] = [];
    for (const line of body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)) {
        const [pin, dateTimeStr, status, verify, workCode] = line.split('\t');
        const scanTime = parseDeviceDateTime(dateTimeStr);
        if (pin && scanTime) {
            rows.push({ pin, scanTime, status, verify, workCode });
        }
    }
    return rows;
}

function parseOperLogLines(body: string): { pin: string; name: string }[] {
    const rows: { pin: string; name: string }[] = [];
    for (const line of body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)) {
        const fields = line.split('\t');
        const pinMatch = fields[0]?.match(/PIN=(\S+)/);
        const nameField = fields.find((f) => f.startsWith('Name='));
        if (!pinMatch || !nameField) continue;
        const name = nameField
            .slice('Name='.length)
            .replace(/\(\d+\)\s*$/, '')
            .trim();
        if (name) rows.push({ pin: pinMatch[1], name });
    }
    return rows;
}

async function main() {
    const logs = await prisma.zk_push_logs.findMany({ orderBy: { received_at: 'asc' } });
    console.log(`Found ${logs.length} zk_push_logs rows.`);

    const scanMap = new Map<string, Prisma.zk_attendance_scansCreateManyInput>();
    const nameHints = new Map<string, { device_sn: string; device_pin: string; suggested_name: string }>();

    for (const log of logs) {
        const payload = log.raw_payload as { query?: Record<string, string>; body?: string };
        const table = (payload?.query?.table ?? payload?.query?.Table ?? '').toUpperCase();
        const body = payload?.body ?? '';
        const sn = log.sn;

        if (table === 'ATTLOG') {
            for (const row of parseAttLogLines(body)) {
                const key = `${sn}|${row.pin}|${row.scanTime.toISOString()}`;
                if (!scanMap.has(key)) {
                    scanMap.set(key, {
                        device_sn: sn,
                        device_pin: row.pin,
                        scan_time: row.scanTime,
                        attendance_date: startOfUTCDay(row.scanTime),
                        verify_mode: row.verify,
                        device_status: row.status,
                        work_code: row.workCode,
                        is_duplicate: false,
                        is_live: false,
                        zk_push_log_id: log.id,
                        received_at: log.received_at,
                    });
                }
            }
        } else if (table === 'OPERLOG') {
            for (const row of parseOperLogLines(body)) {
                nameHints.set(`${sn}|${row.pin}`, { device_sn: sn, device_pin: row.pin, suggested_name: row.name });
            }
        }
    }

    console.log(`Parsed ${scanMap.size} unique attendance scans, ${nameHints.size} unique PIN name hints.`);

    const scanRows = Array.from(scanMap.values());
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < scanRows.length; i += BATCH) {
        const batch = scanRows.slice(i, i + BATCH);
        const result = await prisma.zk_attendance_scans.createMany({ data: batch, skipDuplicates: true });
        inserted += result.count;
    }
    console.log(`Inserted ${inserted} new zk_attendance_scans rows (duplicates skipped).`);

    let hints = 0;
    for (const hint of nameHints.values()) {
        await prisma.zk_pin_name_hints.upsert({
            where: { device_sn_device_pin: { device_sn: hint.device_sn, device_pin: hint.device_pin } },
            create: hint,
            update: { suggested_name: hint.suggested_name },
        });
        hints++;
    }
    console.log(`Upserted ${hints} zk_pin_name_hints rows.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
