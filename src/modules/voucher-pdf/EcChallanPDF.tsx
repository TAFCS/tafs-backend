import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image, Svg, Rect } from '@react-pdf/renderer';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { formatAcademicSessionLabel } from '../../common/utils/academic-labels';
import type { EcVoucherPdfData } from './ec-voucher-pdf.types';

/**
 * TAFSD-605: the extracurricular (EC) fee challan.
 *
 * Same format as the academic FeeChallanPDF (landscape A4, Bank / School /
 * Student copies, the history column on the right) so it reads like a TAFS
 * challan, but it is a separate file on purpose: the academic template must stay
 * byte-identical, and this one prints none of the academic machinery:
 *   - no arrears, surcharge, reprint or late-fee rows, no "payable after due date";
 *   - an Issue date and a VALID TILL date instead of a due date;
 *   - the student's other open EC vouchers are LISTED in the side column, never
 *     added to this voucher's total;
 *   - no 1Bill / bank-app payment options, no 1Bill consumer number, and no CC
 *     printed as a payment reference (a UBL counter resolves a CC to the
 *     ACADEMIC voucher, so the challan says plainly it can't be paid that way).
 *
 * The geometry, styles, HRow and QrCodeView are copied from FeeChallanPDF.tsx
 * (they are private there); keep the two looking alike when either changes.
 */

const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');
const LOGO_BUFFER = fs.readFileSync(LOGO_PATH);

// Mirrors tafs-webapp/src/lib/payment-methods.ts (manual methods only: EC is never paid online).
const PAYMENT_METHOD_LABELS: Record<string, string> = {
    cash: 'CASH',
    bank_transfer: 'BANK TRANSFER',
    cheque: 'CHEQUE',
    online: 'IBFT',
    pos: 'POS',
    pay_order: 'PAY ORDER',
};
const methodLabel = (v?: string | null) => (!v ? '-' : PAYMENT_METHOD_LABELS[v] ?? String(v).toUpperCase().replace(/_/g, ' '));

const QrCodeView = ({ url, size = 36 }: { url: string; size?: number }) => {
    try {
        const qr = QRCode.create(url, { errorCorrectionLevel: 'L' });
        const moduleCount = qr.modules.size;
        const cellSize = size / moduleCount;
        const data: Uint8Array = qr.modules.data;
        return (
            <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <Rect x={0} y={0} width={size} height={size} fill="white" />
                {Array.from(data).map((val, idx) => {
                    if (!val) return null;
                    const x = (idx % moduleCount) * cellSize;
                    const y = Math.floor(idx / moduleCount) * cellSize;
                    return <Rect key={idx} x={x} y={y} width={cellSize} height={cellSize} fill="black" />;
                })}
            </Svg>
        );
    } catch {
        return null as any;
    }
};

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const PAGE_PADDING_V = 6;
const CONTENT_HEIGHT = PAGE_HEIGHT - PAGE_PADDING_V * 2;
const QR_RESERVE = 72;
const CHALLAN_TOP_OFFSET = 4;
const CHALLAN_WIDTH = '85%';
const COLUMN_WIDTH = '15%';
const LONG_TABLE_ROWS = 24;
const isLong = (rows?: unknown[]) => (rows?.length ?? 0) > LONG_TABLE_ROWS;

const EC_ORANGE = '#c2410c';

type HCellSpec = { node: React.ReactNode; align?: 'left' | 'right' | 'center'; color?: string };

const HRow = ({ cols, cells, variant = 'body', last }: { cols: number[]; cells: HCellSpec[]; variant?: 'header' | 'body' | 'total'; last?: boolean }) => {
    const sum = cols.reduce((a, b) => a + b, 0);
    const pct = cols.map((c) => (c / sum) * 100);
    const edges: number[] = [];
    let acc = 0;
    for (let i = 0; i < pct.length - 1; i++) {
        acc += pct[i];
        edges.push(acc);
    }
    const isTotal = variant === 'total';
    const isHeader = variant === 'header';
    return (
        <View
            wrap={false}
            style={{
                flexDirection: 'row',
                position: 'relative',
                paddingVertical: isTotal ? 1.5 : 1,
                backgroundColor: isTotal ? '#1e293b' : undefined,
                borderBottomWidth: last || isTotal ? 0 : isHeader ? 0.5 : 0.3,
                borderBottomColor: isHeader ? '#475569' : '#64748b',
            }}
        >
            {cells.map((c, i) => (
                <View key={i} style={{ width: `${pct[i]}%`, paddingHorizontal: 2 }}>
                    <Text style={{ fontSize: 4, textAlign: c.align, color: c.color ?? (isTotal ? '#ffffff' : '#1e293b'), fontWeight: isHeader || isTotal ? 'bold' : undefined }}>{c.node}</Text>
                </View>
            ))}
            {!isTotal &&
                edges.map((x, i) => <View key={`rule-${i}`} style={{ position: 'absolute', left: `${x}%`, top: 0, bottom: 0, width: 0.3, backgroundColor: '#475569' }} />)}
        </View>
    );
};

const styles = StyleSheet.create({
    page: { flexDirection: 'column', backgroundColor: '#ffffff', paddingHorizontal: 5, paddingTop: PAGE_PADDING_V, paddingBottom: PAGE_PADDING_V + QR_RESERVE, fontSize: 8, fontFamily: 'Helvetica' },
    section: { flex: 1, paddingHorizontal: 7, borderRightWidth: 1, borderRightColor: '#555555', borderRightStyle: 'dashed' },
    lastSection: { borderRightWidth: 0 },
    copyLabel: { position: 'absolute', right: 12, top: -2, backgroundColor: '#000000', color: '#ffffff', padding: '1px 5px', fontSize: 6, fontWeight: 'bold', borderRadius: 2, textTransform: 'uppercase' },
    academicSession: { fontSize: 6, color: '#333333', marginTop: 0 },
    paidStamp: { position: 'absolute', top: '50%', left: '5%', width: '90%', textAlign: 'center', color: '#16a34a', fontSize: 38, fontWeight: 'bold', opacity: 0.18, transform: 'rotate(-35deg)', letterSpacing: 4, fontFamily: 'Helvetica-Bold' },
    pageMark: { position: 'absolute', top: 0, left: 0, width: '100%', height: CONTENT_HEIGHT - QR_RESERVE },
    pageMarkInner: { position: 'absolute', top: -PAGE_PADDING_V, left: -5, width: PAGE_WIDTH, height: PAGE_HEIGHT, alignItems: 'center', justifyContent: 'center' },
    bigStamp: { textAlign: 'center', fontSize: 90, fontWeight: 'bold', opacity: 0.16, transform: 'rotate(-35deg)', letterSpacing: 10, fontFamily: 'Helvetica-Bold' },
    header: { flexDirection: 'column', marginBottom: 3, alignItems: 'center', textAlign: 'center' },
    logo: { width: 36, height: 36, marginBottom: 2 },
    schoolInfo: { alignItems: 'center', marginBottom: 3 },
    schoolName: { fontSize: 10, fontWeight: 'bold', color: '#1a1a1a', letterSpacing: 0.2 },
    schoolAddress: { fontSize: 6, color: '#333333', marginTop: 0 },
    titleBand: { backgroundColor: EC_ORANGE, paddingVertical: 2.5, marginBottom: 4, borderRadius: 2, alignItems: 'center' },
    titleBandText: { color: '#ffffff', fontSize: 7, fontWeight: 'bold', letterSpacing: 1, fontFamily: 'Helvetica-Bold' },
    studentSection: { flexDirection: 'column', backgroundColor: '#f9f9f9', padding: 4, borderRadius: 4, marginBottom: 4, borderWidth: 0.5, borderColor: '#555555', gap: 2 },
    studentCol: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    label: { fontSize: 5, textTransform: 'uppercase', color: '#333333', fontWeight: 'bold' },
    value: { fontSize: 6.8, fontWeight: 'bold', color: '#1a1a1a', textTransform: 'uppercase' },
    feeTable: { width: '100%', marginBottom: 3 },
    tableHeader: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#333333', paddingBottom: 1, marginBottom: 1 },
    tableRow: { flexDirection: 'row', paddingVertical: 1, borderBottomWidth: 0.3, borderBottomColor: '#f0f0f0' },
    totalRow: { flexDirection: 'row', marginTop: 2, paddingVertical: 2, borderTopWidth: 0.5, borderTopColor: '#333333' },
    colDesc: { flex: 3, fontSize: 7.5 },
    colAmount: { flex: 1, textAlign: 'right', fontSize: 7.5 },
    instructions: { fontSize: 5.5, color: '#1a1a1a', lineHeight: 1.1 },
    footerContainer: { marginTop: 'auto', paddingTop: 1 },
    stampSignatureRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 1, marginBottom: 0.5 },
    stampBox: { width: 34, height: 8, borderWidth: 0.5, borderColor: '#999999', justifyContent: 'center', alignItems: 'center' },
    stampText: { fontSize: 3.8, color: '#444444', fontWeight: 'bold' },
    signatureLineContainer: { justifyContent: 'flex-end', alignItems: 'center' },
    signatureLine: { width: 50, borderTopWidth: 0.5, borderTopColor: '#333333', paddingTop: 1, alignItems: 'center' },
    signatureText: { fontSize: 4.2, color: '#333333', fontWeight: 'bold' },
    generatedBy: { fontSize: 3.8, color: '#555555', textAlign: 'left' },
    bankNoteContainer: { backgroundColor: '#f8fafc', padding: 4, marginBottom: 4, borderWidth: 0.5, borderColor: '#cbd5e1', borderRadius: 2 },
    bankNoteLabel: { fontSize: 5.5, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 1 },
    bankNoteText: { fontSize: 5.5, color: '#1a1a1a', fontWeight: 'bold' },
    payNotice: { borderWidth: 0.5, borderColor: EC_ORANGE, backgroundColor: '#fff7ed', padding: 3, marginTop: 4, borderRadius: 2 },
    payNoticeText: { fontSize: 5, color: '#7c2d12', fontWeight: 'bold', textAlign: 'center' },
    footer: { marginTop: 8, flexDirection: 'column' },
    historySection: { marginBottom: 8 },
    historyTitle: { fontSize: 6, fontWeight: 'bold', color: '#1e293b', backgroundColor: '#f1f5f9', padding: '2px 4px', marginBottom: 3, textTransform: 'uppercase', borderLeftWidth: 2, borderLeftColor: EC_ORANGE, borderLeftStyle: 'solid' },
    historyTable: { width: '100%', borderWidth: 0.5, borderColor: '#475569' },
});

const ddmmyyyy = (d: string) => {
    const [y, m, day] = (d || '').split('-');
    return y && m && day ? `${day}/${m}/${y}` : d || '-';
};
const rs = (n: number) => Math.round(n).toLocaleString('en-PK', { maximumFractionDigits: 0 });

function formatPktTimestamp(iso: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Karachi',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

const ChallanCopy = ({ copyType, data, isLast }: { copyType: string; data: EcVoucherPdfData; isLast?: boolean }) => {
    const s = data.student;
    const received = data.amountPaid > 0 && data.stamp !== 'PAID';
    return (
        <View style={[styles.section, isLast ? styles.lastSection : {}]}>
            <Text style={styles.copyLabel}>{copyType}</Text>
            {data.stamp === 'PAID' && <Text style={styles.paidStamp}>PAID</Text>}

            <View style={styles.header}>
                <Image src={{ data: LOGO_BUFFER, format: 'png' }} style={styles.logo} />
                <View style={styles.schoolInfo}>
                    <Text style={styles.schoolName}>THE AMERICAN FOUNDATION SCHOOL</Text>
                    <Text style={styles.schoolAddress}>{(data.campusName || 'Main Campus').toUpperCase()}</Text>
                    <Text style={styles.academicSession}>{formatAcademicSessionLabel(data.academicYear)}</Text>
                    <Text style={styles.schoolAddress}>{(data.bank.name || '').toUpperCase()}</Text>
                    <Text style={styles.schoolAddress}>COLLECTION A/C {data.bank.account}</Text>
                </View>
            </View>

            <View style={styles.titleBand}>
                <Text style={styles.titleBandText}>EXTRACURRICULAR FEE VOUCHER</Text>
            </View>

            <View style={styles.studentSection}>
                <View style={styles.studentCol}>
                    <View style={{ flex: 1.85, paddingRight: 2 }}>
                        <Text style={styles.label}>Student Name</Text>
                        <Text style={styles.value}>{s.fullName}</Text>
                    </View>
                    <View style={{ flex: 0.72, paddingRight: 2 }}>
                        <Text style={styles.label}>Gender</Text>
                        <Text style={styles.value}>{s.gender || 'N/A'}</Text>
                    </View>
                    <View style={{ flex: 0.72, paddingRight: 2 }}>
                        <Text style={styles.label}>CC#</Text>
                        <Text style={styles.value}>{s.cc}</Text>
                    </View>
                    <View style={{ flex: 0.95, alignItems: 'flex-end' }}>
                        <Text style={[styles.label, { textAlign: 'right' }]}>Issue Date</Text>
                        <Text style={[styles.value, { textAlign: 'right' }]}>{ddmmyyyy(data.issueDate)}</Text>
                    </View>
                </View>
                <View style={styles.studentCol}>
                    <View style={{ flex: 1.85, paddingRight: 2 }}>
                        <Text style={styles.label}>Father&apos;s Name</Text>
                        <Text style={styles.value}>{s.fatherName || 'N/A'}</Text>
                    </View>
                    <View style={{ flex: 0.72, paddingRight: 2 }}>
                        <Text style={styles.label}>House</Text>
                        <Text style={styles.value}>{s.houseName || 'N/A'}</Text>
                    </View>
                    <View style={{ flex: 0.72, paddingRight: 2 }}>
                        <Text style={styles.label}>GR#</Text>
                        <Text style={styles.value}>{s.grNumber}</Text>
                    </View>
                    <View style={{ flex: 0.95, alignItems: 'flex-end' }}>
                        <Text style={[styles.label, { textAlign: 'right', color: '#dc2626' }]}>Valid Till</Text>
                        <Text style={[styles.value, { textAlign: 'right', color: '#dc2626' }]}>{ddmmyyyy(data.expiryDate)}</Text>
                    </View>
                </View>
                <View style={styles.studentCol}>
                    <View style={{ flex: 1.85, paddingRight: 2 }}>
                        <Text style={styles.label}>Voucher #</Text>
                        <Text style={styles.value}>{data.voucherNumber}</Text>
                    </View>
                    <View style={{ flex: 0.72, paddingRight: 2 }}>
                        <Text style={styles.label}>Level</Text>
                        <Text style={styles.value}>{s.className}</Text>
                    </View>
                    <View style={{ flex: 0.72, paddingRight: 2 }}>
                        <Text style={styles.label}>Section</Text>
                        <Text style={styles.value}>{s.sectionName}</Text>
                    </View>
                    <View style={{ flex: 0.95, alignItems: 'flex-end' }}>
                        <Text style={[styles.label, { textAlign: 'right' }]}>Late Fee</Text>
                        <Text style={[styles.value, { textAlign: 'right' }]}>NONE</Text>
                    </View>
                </View>
                <View style={{ marginTop: 2, borderTopWidth: 0.5, borderTopColor: '#efefef', paddingTop: 2 }}>
                    <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
                        <Text style={{ fontSize: 5.5, color: '#333333', fontWeight: 'bold' }}>FOR MONTH(S) OF:</Text>
                        <Text style={{ flex: 1, fontSize: 7, color: '#1a1a1a', fontWeight: 'bold' }} wrap={false}>
                            {data.monthsLabel}
                        </Text>
                    </View>
                </View>
            </View>

            <View style={[styles.feeTable, { marginTop: 4 }]}>
                <View style={styles.tableHeader}>
                    <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>DESCRIPTION</Text>
                    <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>AMOUNT</Text>
                </View>
                {data.lines.map((l, i) => (
                    <View key={i} style={styles.tableRow}>
                        <Text style={styles.colDesc}>{l.description}</Text>
                        <Text style={styles.colAmount}>{rs(l.amount)}</Text>
                    </View>
                ))}
                {received ? (
                    <>
                        <View style={[styles.totalRow, { marginTop: 4 }]}>
                            <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>TOTAL</Text>
                            <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>{rs(data.totalAmount)}</Text>
                        </View>
                        <View style={styles.tableRow}>
                            <Text style={[styles.colDesc, { color: '#16a34a' }]}>LESS: RECEIVED</Text>
                            <Text style={[styles.colAmount, { color: '#16a34a' }]}>-{rs(data.amountPaid)}</Text>
                        </View>
                        <View style={[styles.totalRow, { marginTop: 0, borderBottomWidth: 0.5, borderBottomColor: '#333333', paddingBottom: 2 }]}>
                            <Text style={[styles.colDesc, { fontWeight: 'bold', color: EC_ORANGE }]}>BALANCE PAYABLE</Text>
                            <Text style={[styles.colAmount, { fontWeight: 'bold', fontSize: 9, color: EC_ORANGE }]}>{rs(data.balance)}</Text>
                        </View>
                    </>
                ) : (
                    <View style={[styles.totalRow, { borderBottomWidth: 0.5, borderBottomColor: '#333333', paddingBottom: 2, marginTop: 4 }]}>
                        <Text style={[styles.colDesc, { fontWeight: 'bold', color: EC_ORANGE }]}>TOTAL PAYABLE</Text>
                        <Text style={[styles.colAmount, { fontWeight: 'bold', fontSize: 9, color: EC_ORANGE }]}>{rs(data.totalAmount)}</Text>
                    </View>
                )}
                <View style={styles.payNotice}>
                    <Text style={styles.payNoticeText}>PAYABLE UP TO {ddmmyyyy(data.expiryDate)} ONLY · NO LATE FEE · NOT ADDED TO THE TUITION FEE VOUCHER</Text>
                </View>
            </View>

            <View style={styles.footerContainer}>
                <View style={styles.bankNoteContainer}>
                    <Text style={styles.bankNoteLabel}>NOTE FOR BANK:</Text>
                    <Text style={styles.bankNoteText}>
                        THESE FUNDS ARE INTENDED FOR THE AMERICAN FOUNDATION SCHOOL&apos;S ACCOUNT {data.bank.iban || data.bank.account}
                        {data.bank.title ? ` (${data.bank.title.toUpperCase()})` : ''}. ACCEPT AT THE COUNTER AGAINST THIS VOUCHER ONLY.
                    </Text>
                </View>

                <View style={styles.footer}>
                    <Text style={{ fontSize: 5, fontWeight: 'bold', marginBottom: 2 }}>IMPORTANT:</Text>
                    <Text style={styles.instructions}>1. THIS IS AN EXTRACURRICULAR FEE VOUCHER, SEPARATE FROM THE TUITION FEE VOUCHER. PAY IT ON ITS OWN.</Text>
                    <Text style={styles.instructions}>2. NO LATE FEE APPLIES. THIS VOUCHER CAN BE PAID ONLY UP TO THE VALID-TILL DATE; AFTER THAT IT IS VOID AND THE ACCOUNTS OFFICE CAN REISSUE IT.</Text>
                    <Text style={styles.instructions}>3. AMOUNTS ON THIS VOUCHER ARE NEVER ADDED TO THE TUITION FEE VOUCHER OR CARRIED FORWARD AS ARREARS.</Text>
                    <Text style={styles.instructions}>4. PAY AT THE BANK COUNTER OR THE SCHOOL ACCOUNTS OFFICE ONLY. NOT PAYABLE THROUGH 1BILL, BANKING APPS OR BY QUOTING THE STUDENT&apos;S CC NUMBER.</Text>
                    <Text style={styles.instructions}>5. KEEP THE STUDENT COPY, STAMPED BY THE BANK OR THE ACCOUNTS OFFICE, AS YOUR RECEIPT.</Text>

                    <View style={styles.stampSignatureRow}>
                        <View style={styles.stampBox}>
                            <Text style={styles.stampText}>BANK&apos;S STAMP</Text>
                        </View>
                        <View style={styles.signatureLineContainer}>
                            <View style={styles.signatureLine}>
                                <Text style={styles.signatureText}>HEAD OF INSTITUTION</Text>
                            </View>
                        </View>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 1, borderTopWidth: 0.5, borderTopColor: '#efefef', paddingTop: 0.5 }}>
                        <Text style={[styles.generatedBy, { flex: 1 }]}>
                            GENERATED BY {data.generatedByName.toUpperCase()} · {formatPktTimestamp(data.generatedAt)}
                        </Text>
                    </View>
                </View>
            </View>
        </View>
    );
};

export const EcChallanPDF = ({ data }: { data: EcVoucherPdfData }) => (
    <Document>
        <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page} wrap>
            <View style={{ position: 'absolute', top: 0, left: 0, width: CHALLAN_WIDTH, height: CONTENT_HEIGHT - QR_RESERVE }}>
                <View style={{ position: 'absolute', top: CHALLAN_TOP_OFFSET, left: 0, width: '100%', height: CONTENT_HEIGHT - CHALLAN_TOP_OFFSET, flexDirection: 'row' }}>
                    <ChallanCopy copyType="Bank Copy" data={data} />
                    <ChallanCopy copyType="School Copy" data={data} />
                    <ChallanCopy copyType="Student Copy" data={data} isLast />
                </View>
            </View>

            <View style={{ marginLeft: CHALLAN_WIDTH, width: COLUMN_WIDTH, paddingLeft: 8, flexDirection: 'column' }}>
                {/* OTHER UNPAID EC VOUCHERS: listed beside this one, never added to it. */}
                <View style={styles.historySection} wrap={isLong(data.otherOpenVouchers)}>
                    <Text style={styles.historyTitle}>{'OTHER UNPAID EXTRACURRICULAR VOUCHERS\n(NOT INCLUDED IN THIS VOUCHER)'}</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [1.6, 1.1, 0.9];
                            const rows = data.otherOpenVouchers;
                            return (
                                <>
                                    <View fixed={isLong(rows)}>
                                        <HRow cols={COLS} variant="header" cells={[{ node: 'VOUCHER #' }, { node: 'VALID TILL' }, { node: 'BALANCE', align: 'right' }]} />
                                    </View>
                                    {rows.length > 0 ? (
                                        <>
                                            {rows.map((v, idx) => (
                                                <HRow
                                                    key={idx}
                                                    cols={COLS}
                                                    cells={[
                                                        { node: v.voucherNumber },
                                                        { node: v.lapsed ? 'LAPSED' : ddmmyyyy(v.validTill), color: v.lapsed ? '#dc2626' : undefined },
                                                        { node: rs(v.balance), align: 'right' },
                                                    ]}
                                                />
                                            ))}
                                            <HRow cols={[2.7, 0.9]} variant="total" cells={[{ node: 'NOT INCLUDED ABOVE' }, { node: rs(rows.reduce((n, v) => n + v.balance, 0)), align: 'right' }]} />
                                        </>
                                    ) : (
                                        <HRow cols={[1]} last cells={[{ node: 'None', align: 'center' }]} />
                                    )}
                                </>
                            );
                        })()}
                    </View>
                </View>

                {/* PAYMENT HISTORY (LAST 3 EC PAYMENTS) */}
                <View style={styles.historySection} wrap={isLong(data.payments)}>
                    <Text style={styles.historyTitle}>{'PAYMENT HISTORY\n(LAST 3 EXTRACURRICULAR PAYMENTS)'}</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [0.95, 1.6, 0.8, 0.8];
                            const rows = data.payments;
                            return (
                                <>
                                    <View fixed={isLong(rows)}>
                                        <HRow cols={COLS} variant="header" cells={[{ node: 'DATE' }, { node: 'VOUCHER #' }, { node: 'METHOD' }, { node: 'AMOUNT', align: 'right' }]} />
                                    </View>
                                    {rows.length > 0 ? (
                                        <>
                                            {rows.map((p, idx) => (
                                                <HRow key={idx} cols={COLS} cells={[{ node: ddmmyyyy(p.date) }, { node: p.voucherNumber }, { node: methodLabel(p.method) }, { node: rs(p.amount), align: 'right' }]} />
                                            ))}
                                            <HRow cols={[3.35, 0.8]} variant="total" cells={[{ node: 'TOTAL SHOWN' }, { node: rs(rows.reduce((n, p) => n + p.amount, 0)), align: 'right' }]} />
                                        </>
                                    ) : (
                                        <HRow cols={COLS} last cells={[{ node: '-' }, { node: '-' }, { node: '-' }, { node: '-', align: 'right' }]} />
                                    )}
                                </>
                            );
                        })()}
                    </View>
                </View>

                {/* SIBLINGS */}
                <View style={styles.historySection} wrap={isLong(data.siblings)}>
                    <Text style={styles.historyTitle}>SIBLINGS</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [0.85, 1.05, 0.9, 2.0];
                            return (
                                <>
                                    <View fixed={isLong(data.siblings)}>
                                        <HRow cols={COLS} variant="header" cells={[{ node: 'CC' }, { node: 'GR' }, { node: 'LVL' }, { node: 'NAME' }]} />
                                    </View>
                                    {data.siblings.length > 0 ? (
                                        data.siblings.map((s, idx) => (
                                            <HRow key={idx} cols={COLS} last={idx === data.siblings.length - 1} cells={[{ node: s.cc }, { node: s.grNumber }, { node: s.className }, { node: s.fullName }]} />
                                        ))
                                    ) : (
                                        <HRow cols={[1]} last cells={[{ node: 'No siblings', align: 'center' }]} />
                                    )}
                                </>
                            );
                        })()}
                    </View>
                </View>
            </View>

            <View fixed style={{ position: 'absolute', top: 0, left: CHALLAN_WIDTH, width: 1, height: CONTENT_HEIGHT, backgroundColor: '#e4e4e4' }} />

            {data.qrUrl && (
                <View
                    fixed
                    style={{ position: 'absolute', top: CONTENT_HEIGHT - QR_RESERVE, height: QR_RESERVE, left: CHALLAN_WIDTH, width: COLUMN_WIDTH, paddingLeft: 8, alignItems: 'center', paddingTop: 6, borderTopWidth: 0.5, borderTopColor: '#e2e8f0' }}
                >
                    <QrCodeView url={data.qrUrl} size={52} />
                    <Text style={{ fontSize: 4, color: '#334155', marginTop: 2, textAlign: 'center', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.3 }}>Scan to open PDF</Text>
                </View>
            )}

            {(data.stamp === 'WAIVED' || data.stamp === 'EXPIRED') && (
                <View style={styles.pageMark}>
                    <View style={styles.pageMarkInner}>
                        <Text style={[styles.bigStamp, { color: data.stamp === 'WAIVED' ? '#0f766e' : '#dc2626' }]}>{data.stamp}</Text>
                    </View>
                </View>
            )}
        </Page>
    </Document>
);
