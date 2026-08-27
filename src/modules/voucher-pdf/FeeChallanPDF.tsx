import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image, Font, Svg, Rect } from '@react-pdf/renderer';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';

const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');
const LOGO_BUFFER = fs.readFileSync(LOGO_PATH);

// Mirrors tafs-webapp/src/lib/payment-methods.ts — keep both in sync
const PAYMENT_METHOD_LABELS: Record<string, string> = {
    cash: 'CASH',
    bank_transfer: 'BANK TRANSFER',
    cheque: 'CHEQUE',
    online: 'IBFT',
    pos: 'POS',
    pay_order: 'PAY ORDER',
    meezan: 'MEEZAN BANK',
};

function formatPaymentMethod(value?: string | null): string {
    if (!value) return '-';
    return PAYMENT_METHOD_LABELS[value] ?? String(value).toUpperCase().replace(/_/g, ' ');
}

// Renders a QR code via react-pdf native SVG — fully synchronous, no data URL needed
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

// Landscape A4 in points. CONTENT_HEIGHT is the page height minus the vertical padding
// declared on styles.page — the absolutely-positioned challan block needs this as an
// explicit height, because with pagination enabled a `bottom: 0` would instead resolve
// against the unbounded document height and split the copies across pages.
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const PAGE_PADDING_V = 6;
const CONTENT_HEIGHT = PAGE_HEIGHT - PAGE_PADDING_V * 2;
// Vertical strip the fixed QR block occupies at the bottom of every page. It is reserved via
// the Page's own paddingBottom (not the column's) because only page padding applies to *every*
// page — a paddingBottom on the flowing column reserves space once, at the very end, which lets
// rows on continuation pages run underneath the QR.
const QR_RESERVE = 72;
// Nudges the whole challan block (copy tags, logo, header and all) down from the page top.
// The block's height is reduced by the same amount so its bottom edge — and the footer pinned
// to it via `marginTop: 'auto'` — stays put rather than drifting into the page margin.
const CHALLAN_TOP_OFFSET = 4;

// Split of the page between the challan copies and the history column.
const CHALLAN_WIDTH = '85%';
const COLUMN_WIDTH = '15%';

// History tables are kept atomic (wrap={false}) so a table is never split mid-body. That is
// only safe while the table actually fits on a page: react-pdf cannot place an unsplittable
// section taller than the page, so it crushes the whole column and text collides. Any table
// long enough to risk that is allowed to split (repeating its header) instead. The bound is
// deliberately conservative — rows wrap to 2-3 lines, so well under 50 fill the column.
const LONG_TABLE_ROWS = 24;
const isLong = (rows?: unknown[]) => (rows?.length ?? 0) > LONG_TABLE_ROWS;

type HCellSpec = { node: React.ReactNode; align?: 'left' | 'right' | 'center'; color?: string };

/**
 * One row of a history table.
 *
 * Column separators are drawn as absolutely-positioned full-height rules, NOT as
 * borders on the cells. react-pdf sizes a cell to its own wrapped text and will not
 * stretch it to the row height (neither Text nor a flex View, with or without an
 * explicit alignItems: 'stretch'), so cell borders come out ragged — short next to a
 * one-line cell, tall next to a three-line one. An absolute child with top/bottom 0
 * spans the row's real height, giving unbroken vertical rules.
 *
 * `cols` are relative weights; they are normalised to percentages so the rules can be
 * placed at the exact column boundaries.
 */
const HRow = ({ cols, cells, variant = 'body', last }: {
    cols: number[];
    cells: HCellSpec[];
    variant?: 'header' | 'body' | 'total';
    /** last row of the table — drops the bottom border so it does not double the table's own */
    last?: boolean;
}) => {
    const sum = cols.reduce((a, b) => a + b, 0);
    const pct = cols.map(c => (c / sum) * 100);
    const edges: number[] = [];
    let acc = 0;
    for (let i = 0; i < pct.length - 1; i++) { acc += pct[i]; edges.push(acc); }

    const isTotal = variant === 'total';
    const isHeader = variant === 'header';

    return (
        <View wrap={false} style={{
            flexDirection: 'row',
            position: 'relative',
            paddingVertical: isTotal ? 1.5 : 1,
            backgroundColor: isTotal ? '#1e293b' : undefined,
            borderBottomWidth: last || isTotal ? 0 : (isHeader ? 0.5 : 0.3),
            borderBottomColor: isHeader ? '#475569' : '#64748b',
        }}>
            {cells.map((c, i) => (
                <View key={i} style={{ width: `${pct[i]}%`, paddingHorizontal: 2 }}>
                    <Text style={{
                        fontSize: 4,
                        textAlign: c.align,
                        color: c.color ?? (isTotal ? '#ffffff' : '#1e293b'),
                        fontWeight: isHeader || isTotal ? 'bold' : undefined,
                    }}>{c.node}</Text>
                </View>
            ))}
            {!isTotal && edges.map((x, i) => (
                <View key={`rule-${i}`} style={{
                    position: 'absolute', left: `${x}%`, top: 0, bottom: 0,
                    width: 0.3, backgroundColor: '#475569',
                }} />
            ))}
        </View>
    );
};

// Define styles
const styles = StyleSheet.create({
    page: {
        // Column direction: the three challan copies are absolutely positioned, so the
        // history column is the only child in normal flow and positions itself via marginLeft.
        flexDirection: 'column',
        backgroundColor: '#ffffff',
        paddingHorizontal: 5,
        paddingTop: PAGE_PADDING_V,
        paddingBottom: PAGE_PADDING_V + QR_RESERVE,
        fontSize: 8,
        fontFamily: 'Helvetica',
    },
    section: {
        flex: 1,
        paddingHorizontal: 7,
        borderRightWidth: 1,
        borderRightColor: '#555555',
        borderRightStyle: 'dashed',
    },
    lastSection: {
        borderRightWidth: 0,
    },
    copyLabel: {
        position: 'absolute',
        right: 12,
        top: -2,
        backgroundColor: '#000000',
        color: '#ffffff',
        padding: '1px 5px',
        fontSize: 6,
        fontWeight: 'bold',
        borderRadius: 2,
        textTransform: 'uppercase',
    },
    paidStamp: {
        position: 'absolute',
        top: '50%',
        left: '5%',
        width: '90%',
        textAlign: 'center',
        color: '#16a34a',
        fontSize: 38,
        fontWeight: 'bold',
        opacity: 0.18,
        transform: 'rotate(-35deg)',
        letterSpacing: 4,
        fontFamily: 'Helvetica-Bold',
    },
    header: {
        flexDirection: 'column',
        marginBottom: 3,
        alignItems: 'center',
        textAlign: 'center',
    },
    logo: {
        width: 36,
        height: 36,
        marginBottom: 2,
    },
    schoolInfo: {
        alignItems: 'center',
        marginBottom: 3,
    },
    schoolName: {
        fontSize: 10,
        fontWeight: 'bold',
        color: '#1a1a1a',
        letterSpacing: 0.2,
    },
    schoolAddress: {
        fontSize: 6,
        color: '#333333',
        marginTop: 0,
    },
    studentSection: {
        flexDirection: 'column',
        backgroundColor: '#f9f9f9',
        padding: 4,
        borderRadius: 4,
        marginBottom: 4,
        borderWidth: 0.5,
        borderColor: '#555555',
        gap: 2,
    },
    studentCol: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    label: {
        fontSize: 6,
        textTransform: 'uppercase',
        color: '#333333',
        fontWeight: 'bold',
    },
    value: {
        fontSize: 8,
        fontWeight: 'bold',
        color: '#1a1a1a',
    },
    datesSection: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 3,
        paddingHorizontal: 2,
    },
    dateItem: {
        width: '24%',
    },
    dateLabel: {
        fontSize: 5,
        color: '#333333',
        textTransform: 'uppercase',
        marginBottom: 1,
    },
    dateValue: {
        fontSize: 6.5,
        fontWeight: 'bold',
        color: '#1a1a1a',
    },
    feeTable: {
        width: '100%',
        marginBottom: 3,
    },
    tableHeader: {
        flexDirection: 'row',
        borderBottomWidth: 0.5,
        borderBottomColor: '#333333',
        paddingBottom: 1,
        marginBottom: 1,
    },
    tableRow: {
        flexDirection: 'row',
        paddingVertical: 1,
        borderBottomWidth: 0.3,
        borderBottomColor: '#f0f0f0',
    },
    totalRow: {
        flexDirection: 'row',
        marginTop: 2,
        paddingVertical: 2,
        borderTopWidth: 0.5,
        borderTopColor: '#333333',
    },
    colDesc: { flex: 3, fontSize: 7.5 },
    colAmount: { flex: 1, textAlign: 'right', fontSize: 7.5 },
    sectionLabelRow: {
        backgroundColor: '#f8fafc',
        paddingVertical: 2,
        paddingHorizontal: 2,
        marginTop: 3,
        marginBottom: 1,
        borderLeftWidth: 2,
        borderLeftColor: '#94a3b8',
        borderLeftStyle: 'solid',
    },
    sectionLabelRowArrear: {
        backgroundColor: '#fffbeb',
        paddingVertical: 2,
        paddingHorizontal: 2,
        marginTop: 3,
        marginBottom: 1,
        borderLeftWidth: 2,
        borderLeftColor: '#f59e0b',
        borderLeftStyle: 'solid',
    },
    sectionLabel: {
        fontSize: 5,
        fontWeight: 'bold',
        color: '#334155',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    sectionLabelArrear: {
        fontSize: 5,
        fontWeight: 'bold',
        color: '#b45309',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    instructions: {
        fontSize: 5.5,
        color: '#1a1a1a',
        lineHeight: 1.1,
    },
    bankDetailsRow: {
        flexDirection: 'row',
        marginBottom: 1,
    },
    bankDetailsLabel: {
        width: 70,
        fontSize: 6,
        color: '#333333',
        fontWeight: 'bold',
    },
    bankDetailsValue: {
        flex: 1,
        fontSize: 6.5,
        color: '#1a1a1a',
        fontWeight: 'bold',
    },
    footerContainer: {
        marginTop: 'auto',
        paddingTop: 5,
    },
    stampSignatureRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 10,
        marginBottom: 3,
    },
    stampBox: {
        width: 60,
        height: 22,
        borderWidth: 1,
        borderColor: '#999999',
        justifyContent: 'center',
        alignItems: 'center',
    },
    stampText: {
        fontSize: 6,
        color: '#333333',
        fontWeight: 'bold',
    },
    signatureLineContainer: {
        justifyContent: 'flex-end',
        alignItems: 'center',
    },
    signatureLine: {
        width: 80,
        borderTopWidth: 0.5,
        borderTopColor: '#333333',
        paddingTop: 2,
        alignItems: 'center',
    },
    signatureText: {
        fontSize: 6,
        color: '#333333',
        fontWeight: 'bold',
    },
    generatedBy: {
        fontSize: 5,
        color: '#333333',
        textAlign: 'center',
        marginTop: 5,
        borderTopWidth: 0.5,
        borderTopColor: '#efefef',
        paddingTop: 2,
    },
    bankNoteContainer: {
        backgroundColor: '#f8fafc',
        padding: 4,
        marginBottom: 4,
        borderWidth: 0.5,
        borderColor: '#cbd5e1',
        borderRadius: 2,
    },
    bankNoteLabel: {
        fontSize: 5.5,
        fontWeight: 'bold',
        color: '#1a1a1a',
        marginBottom: 1,
    },
    bankNoteText: {
        fontSize: 5.5,
        color: '#1a1a1a',
        fontWeight: 'bold',
    },
    footer: {
        marginTop: 8,
        flexDirection: 'column',
    },
    signature: {
        borderTopWidth: 0.5,
        borderTopColor: '#cccccc',
        width: 80,
        textAlign: 'center',
        paddingTop: 3,
        fontSize: 7,
        color: '#333333',
        alignSelf: 'flex-end',
        marginTop: 10,
    },
    paymentOptionsTable: {
        width: '100%',
        marginTop: 4,
        borderWidth: 0.5,
        borderColor: '#333333',
    },
    paymentOptionsHeader: {
        padding: 2,
        backgroundColor: '#e2e8f0',
        borderBottomWidth: 0.5,
        borderBottomColor: '#333333',
        fontSize: 5,
        fontWeight: 'bold',
        textAlign: 'center',
    },
    paymentOptionsRow: {
        flexDirection: 'row',
        borderBottomWidth: 0.5,
        borderBottomColor: '#333333',
    },
    paymentOptionsCol1: {
        flex: 1,
        padding: 2,
        borderRightWidth: 0.5,
        borderRightColor: '#333333',
        fontSize: 4.5,
        justifyContent: 'center',
    },
    paymentOptionsCol2: {
        flex: 1.5,
        padding: 2,
        fontSize: 4.5,
    },
    // History Table Styles
    historySection: {
        marginBottom: 8,
    },
    historyTitle: {
        fontSize: 6,
        fontWeight: 'bold',
        color: '#1e293b',
        backgroundColor: '#f1f5f9',
        padding: '2px 4px',
        marginBottom: 3,
        textTransform: 'uppercase',
        borderLeftWidth: 2,
        borderLeftColor: '#334155',
        borderLeftStyle: 'solid',
    },
    historyTable: {
        width: '100%',
        borderWidth: 0.5,
        borderColor: '#475569',
    },
    historyTableHeader: {
        flexDirection: 'row',
        // Explicit stretch: every cell takes the full row height, so the per-cell right
        // borders form unbroken vertical column separators.
        alignItems: 'stretch',
        borderBottomWidth: 0.5,
        borderBottomColor: '#475569',
        paddingVertical: 1,
    },
    historyTableRow: {
        flexDirection: 'row',
        // Explicit stretch: short cells still take the full row height, so the per-cell
        // right borders form unbroken vertical column separators.
        alignItems: 'stretch',
        borderBottomWidth: 0.3,
        borderBottomColor: '#64748b',
        paddingVertical: 1,
    },
});

export interface FeeItem {
    description: string;
    amount: number;        // original (before discount)
    netAmount?: number;    // after discount (if any)
    discount?: number;     // discount amount
    discountLabel?: string;
    isArrear?: boolean;    // true = this row belongs to the ARREARS section
    isSurcharge?: boolean; // true = this row is a surcharge/late fee
    feeDate?: string;      // underlying fee_date (for ARREAR rows)
}

const formatDateToDDMMYYYY = (dateStr: string) => {
    if (!dateStr || dateStr === 'N/A') return dateStr;
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
};

interface FeeChallanPDFProps {
    student: {
        cc: number | string;
        student_full_name: string;
        gr_number: string;
        campus: string;
        class_id: number;
        section_id?: number;
        className: string;
        sectionName: string;
        grade_and_section: string;
        gender?: string;
        father_name?: string;
    };
    details: {
        month: string;
        academicYear: string;
        issueDate: string;
        dueDate: string;
        validityDate: string;
        applyLateFee: boolean;
        lateFeeAmount?: number;
        applyReprintFee?: boolean;
        reprintFeeAmount?: number;
        voucherNumber: number | string;
        generatedBy: {
            fullName: string;
            timestampStr: string;
        };
        surchargeWaived?: boolean;
        totalSurcharge?: number;
        arrearsLabel?: string;
        bank: {
            name: string;
            title: string;
            account: string;
            branch: string;
            address: string;
            iban: string;
        }
    };
    fees: FeeItem[];
    totalAmount: number;
    showDiscount?: boolean;
    /** When true, a PAID watermark is stamped across each challan copy */
    paidStamp?: boolean;
    siblings?: {
        full_name: string;
        cc: number | string;
        gr_number: string;
        className: string;
        sectionName: string;
        status?: string;
    }[];
    arrearsHistory?: any[];
    installmentsHistory?: any[];
    paymentHistory?: any[];
    /** PDF URL (DigitalOcean Spaces) to encode in the QR code in the history column */
    qrUrl?: string;
}

const ChallanCopy = ({ copyType, student, details, fees, totalAmount, siblings, showDiscount, paidStamp, isLast }: { copyType: string, isLast?: boolean } & FeeChallanPDFProps) => (
    <View style={[styles.section, isLast ? styles.lastSection : {}]}>
        <Text style={styles.copyLabel}>{copyType}</Text>
        {paidStamp && (
            <Text style={styles.paidStamp}>PAID</Text>
        )}

        <View style={styles.header}>
            <Image src={{ data: LOGO_BUFFER, format: 'png' }} style={styles.logo} />
            <View style={styles.schoolInfo}>
                <Text style={styles.schoolName}>THE AMERICAN FOUNDATION SCHOOL</Text>
                <Text style={styles.schoolAddress}>{student.campus || "Main Campus"}</Text>
                <Text style={styles.schoolAddress}>{details.academicYear}</Text>
                <Text style={styles.schoolAddress}>{details.bank.name.toUpperCase()}</Text>
                <Text style={styles.schoolAddress}>COLLECTION A/C {details.bank.account}</Text>
            </View>
        </View>

        <View style={styles.studentSection}>
            <View style={styles.studentCol}>
                <View style={{ flex: 3.5 }}>
                    <Text style={styles.label}>Student Name</Text>
                    <Text style={styles.value}>{student.student_full_name}</Text>
                </View>
                <View style={{ minWidth: 42, flexShrink: 0, alignItems: 'flex-end' }}>
                    <Text style={[styles.label, { textAlign: 'right' }]}>Gender</Text>
                    <Text style={[styles.value, { textAlign: 'right' }]}>{student.gender || 'N/A'}</Text>
                </View>
            </View>
            <View style={styles.studentCol}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.label}>CC#</Text>
                    <Text style={styles.value}>{student.cc}</Text>
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.label}>GR#</Text>
                    <Text style={styles.value}>{student.gr_number}</Text>
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Level</Text>
                    <Text style={styles.value}>{student.className}</Text>
                </View>
                <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Text style={[styles.label, { textAlign: 'right' }]}>Section</Text>
                    <Text style={[styles.value, { textAlign: 'right' }]}>{student.sectionName}</Text>
                </View>
            </View>
            <View style={styles.studentCol}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Voucher #</Text>
                    <Text style={styles.value}>{details.voucherNumber}</Text>
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Issue Date</Text>
                    <Text style={styles.value}>{formatDateToDDMMYYYY(details.issueDate)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Due Date</Text>
                    <Text style={styles.value}>{formatDateToDDMMYYYY(details.dueDate)}</Text>
                </View>
                <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Text style={[styles.label, { textAlign: 'right' }]}>Validity</Text>
                    <Text style={[styles.value, { color: '#e11d48', textAlign: 'right' }]}>{formatDateToDDMMYYYY(details.validityDate)}</Text>
                </View>
            </View>
            <View style={{ marginTop: 2, borderTopWidth: 0.5, borderTopColor: '#efefef', paddingTop: 2, flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 6, color: '#333333', fontWeight: 'bold' }}>FOR MONTH(S) OF:</Text>
                <Text style={{ fontSize: 7, color: '#1a1a1a', fontWeight: 'bold' }}>{details.month}</Text>
            </View>
        </View>

        {/* <View style={[styles.studentSection, { backgroundColor: '#f8fafc', borderColor: '#cbd5e1', paddingVertical: 2 }]}>
            <Text style={[styles.value, { textAlign: 'center', fontSize: 7, marginBottom: 1 }]}>Meezan bank limited</Text>
            <Text style={[styles.value, { textAlign: 'center', fontSize: 6, color: '#4b5563', marginBottom: 1 }]}>All meezan bank branches in Pakistan</Text>
            <Text style={[styles.value, { textAlign: 'center', fontSize: 6, color: '#4b5563' }]}>MBL Code: TAFCS</Text>
        </View> */}

        <View style={[styles.feeTable, { marginTop: 4 }]}>
            {(() => {
                const renderFeeRow = (fee: any, i: string | number) => {
                    const effectiveNet = fee.netAmount ?? fee.amount;
                    const isMTF = fee.description.toLowerCase().includes('tuition');
                    const hasDiscount = showDiscount !== false && Number(fee.discount) > 0;
                    const hasScholarship = showDiscount !== false && Number(fee.scholarship) > 0;
                    const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

                    if (isMTF && (hasDiscount || hasScholarship)) {
                        const amountAfterDiscount = fee.amountAfterDiscount ?? fee.amount;
                        const scholarshipPct = fee.scholarshipPercentage != null ? ` (${fee.scholarshipPercentage}%)` : '';
                        return (
                            <React.Fragment key={i}>
                                <View style={[styles.tableRow, { borderBottomWidth: 0, paddingBottom: 0.5 }]}>
                                    <Text style={styles.colDesc}>{fee.description}</Text>
                                    <Text style={styles.colAmount}>{fmt(fee.amount)}</Text>
                                </View>
                                {hasDiscount && (
                                    <React.Fragment>
                                        <View style={[styles.tableRow, { borderBottomWidth: 0, paddingBottom: 0.5 }]}>
                                            <Text style={[styles.colDesc, { color: '#16a34a' }]}>{`DISCOUNT ON ${fee.description}`}</Text>
                                            <Text style={[styles.colAmount, { color: '#16a34a' }]}>-{fmt(fee.discount)}</Text>
                                        </View>
                                        <View style={hasScholarship ? [styles.tableRow, { borderBottomWidth: 0, paddingBottom: 0.5 }] : styles.tableRow}>
                                            <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>{`${fee.description} AFTER DISCOUNT`}</Text>
                                            <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>{fmt(amountAfterDiscount)}</Text>
                                        </View>
                                    </React.Fragment>
                                )}
                                {hasScholarship && (
                                    <React.Fragment>
                                        <View style={[styles.tableRow, { borderBottomWidth: 0, paddingBottom: 0.5 }]}>
                                            <Text style={[styles.colDesc, { color: '#16a34a' }]}>{`SCHOLARSHIP ON ${fee.description}${scholarshipPct}`}</Text>
                                            <Text style={[styles.colAmount, { color: '#16a34a' }]}>-{fmt(fee.scholarship)}</Text>
                                        </View>
                                        <View style={styles.tableRow}>
                                            <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>{`${fee.description} AFTER SCHOLARSHIP`}</Text>
                                            <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>{fmt(effectiveNet)}</Text>
                                        </View>
                                    </React.Fragment>
                                )}
                            </React.Fragment>
                        );
                    }

                    return (
                        <View key={i} style={styles.tableRow}>
                            <Text style={styles.colDesc}>{fee.description}</Text>
                            <Text style={styles.colAmount}>{fmt(effectiveNet)}</Text>
                        </View>
                    );
                };

                return (
                    <>
                        <View style={styles.tableHeader}>
                            <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>DESCRIPTION</Text>
                            <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>AMOUNT</Text>
                        </View>

                        {(() => {
                            const arrearFees = fees.filter(f => f.isArrear && !f.isSurcharge);
                            const currentFees = fees.filter(f => !f.isArrear && !f.isSurcharge);
                            const arrearTotal = arrearFees.reduce((s, f) => s + (f.netAmount || 0), 0);
                            const hasArrearSurcharge = details.totalSurcharge != null && details.totalSurcharge > 0;

                            return (
                                <>
                                    {arrearFees.length > 0 && (
                                        <View style={styles.tableRow}>
                                            <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>
                                                {details.arrearsLabel || 'TOTAL ARREARS'}
                                            </Text>
                                            <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>
                                                {Math.round(arrearTotal).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                            </Text>
                                        </View>
                                    )}
                                    {hasArrearSurcharge && (
                                        <>
                                            <View style={styles.tableRow}>
                                                <Text style={styles.colDesc}>PREVIOUS MONTHS' LATE PAYMENT SURCHARGE</Text>
                                                <Text style={styles.colAmount}>
                                                    {Math.round(details.totalSurcharge!).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                                </Text>
                                            </View>
                                            {details.surchargeWaived && (
                                                <View style={styles.tableRow}>
                                                    <Text style={[styles.colDesc, { color: '#16a34a' }]}>SURCHARGE WAIVED</Text>
                                                    <Text style={[styles.colAmount, { color: '#16a34a' }]}>
                                                        -{Math.round(details.totalSurcharge!).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                                    </Text>
                                                </View>
                                            )}
                                        </>
                                    )}
                                    {currentFees.map((fee, idx) => renderFeeRow(fee, `c-${idx}`))}
                                    {details.applyReprintFee && (
                                        <View style={styles.tableRow}>
                                            <Text style={styles.colDesc}>REPRINT FEE</Text>
                                            <Text style={styles.colAmount}>
                                                {Math.round(details.reprintFeeAmount || 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                            </Text>
                                        </View>
                                    )}
                                </>
                            );
                        })()}

                        <View style={[styles.totalRow, { borderBottomWidth: 0.5, borderBottomColor: '#333333', paddingBottom: 2, marginTop: 4 }]}>
                            <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>PAYABLE BY DUE DATE</Text>
                            <Text style={[styles.colAmount, { fontWeight: 'bold', fontSize: 9 }]}>
                                {Math.round(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </Text>
                        </View>
                    </>
                );
            })()}

            {details.applyLateFee && (
                <View style={[styles.tableRow, { borderBottomWidth: 0, marginTop: 2 }]}>
                    <Text style={styles.colDesc}>LATE PAYMENT SURCHARGE</Text>
                    <Text style={styles.colAmount}>{Math.round(details.lateFeeAmount || 1000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</Text>
                </View>
            )}

            <View style={[styles.totalRow, { marginTop: 0, paddingTop: 2 }]}>
                <Text style={[styles.colDesc, { fontWeight: 'bold', color: '#e11d48' }]}>PAYABLE AFTER DUE DATE</Text>
                <Text style={[styles.colAmount, { fontWeight: 'bold', fontSize: 9, color: '#e11d48' }]}>
                    {Math.round(totalAmount + (details.applyLateFee ? (details.lateFeeAmount || 1000) : 0)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </Text>
            </View>
        </View>

        <View style={styles.footerContainer}>
            <View style={styles.bankNoteContainer}>
                <Text style={styles.bankNoteLabel}>NOTE FOR BANK:</Text>
                <Text style={styles.bankNoteText}>THESE FUNDS ARE INTENDED FOR THE AMERICAN FOUNDATION SCHOOL'S ACCOUNT {details.bank.iban || details.bank.account} HELD WITH GULISTAN-E-JAUHAR.</Text>
            </View>

            <View style={styles.footer}>
                <Text style={{ fontSize: 5, fontWeight: 'bold', marginBottom: 2 }}>IMPORTANT POLICIES:</Text>
                <Text style={styles.instructions}>1. ALL ADMISSION AND TUITION FEES ARE STRICTLY NON-REFUNDABLE AND NON-ADJUSTABLE ONCE PAID.</Text>
                <Text style={styles.instructions}>2. A LATE FEE OF PKR {(details.lateFeeAmount || 1000).toLocaleString()}/- APPLIES TO ALL DEPOSITS MADE AFTER THE DUE DATE.</Text>
                <Text style={styles.instructions}>3. A CHARGE OF PKR 100/- WILL BE APPLIED FOR THE ISSUANCE OF ANY DUPLICATE FEE VOUCHER.</Text>
                <Text style={styles.instructions}>4. PARENTS ARE RESPONSIBLE FOR COLLECTING FEE VOUCHERS FROM THEIR RESPECTIVE CAMPUS IF THEY ARE NOT RECEIVED OR DELIVERED BY THE STUDENT.</Text>
                <Text style={styles.instructions}>5. STUDENTS WITH FEES REMAINING UNPAID FOR ONE MONTH BEYOND THE DEADLINE WILL BE SUSPENDED FROM ATTENDING CLASSES UNTIL ALL OUTSTANDING DUES ARE CLEARED.</Text>

                {(details.bank?.name || '').toLowerCase().includes('meezan') && (
                    <View style={styles.paymentOptionsTable}>
                        <View style={styles.paymentOptionsHeader}>
                            <Text>PAYMENT OPTIONS (CASH ACCEPTED)</Text>
                        </View>
                        <View style={styles.paymentOptionsRow}>
                            <View style={styles.paymentOptionsCol1}>
                                <Text style={{ fontWeight: 'bold' }}>BANK COUNTERS</Text>
                            </View>
                            <View style={styles.paymentOptionsCol2}>
                                <Text>CASH, MBL CHEQUES, AND PAY ORDERS ARE ACCEPTED AT ALL MBL BRANCHES.</Text>
                            </View>
                        </View>
                        <View style={styles.paymentOptionsRow}>
                            <View style={styles.paymentOptionsCol1}>
                                <Text style={{ fontWeight: 'bold' }}>CMS ONLINE</Text>
                            </View>
                            <View style={styles.paymentOptionsCol2}>
                                <Text>PAY VIA THE CMS ONLINE DEPOSIT MODULE USING CUSTOMER CODE: TAFCS.</Text>
                            </View>
                        </View>
                        <View style={styles.paymentOptionsRow}>
                            <View style={styles.paymentOptionsCol1}>
                                <Text style={{ fontWeight: 'bold' }}>MBL DIGITAL BANKING</Text>
                            </View>
                            <View style={styles.paymentOptionsCol2}>
                                <Text>SELECT "SCHOOL" AS THE BENEFICIARY FROM THE BILLER OPTION VIA MOBILE OR INTERNET BANKING.</Text>
                            </View>
                        </View>
                        <View style={[styles.paymentOptionsRow, { borderBottomWidth: 0 }]}>
                            <View style={styles.paymentOptionsCol1}>
                                <Text style={{ fontWeight: 'bold' }}>OTHER BANKS/DIGITAL CHANNELS</Text>
                            </View>
                            <View style={styles.paymentOptionsCol2}>
                                <Text>PAY VIA THE "1BILL INVOICES" OPTION USING THE 24-DIGIT INVOICE NUMBER.</Text>
                                <Text style={{ fontWeight: 'bold', marginTop: 1 }}>1BILL ID: 1006259110046</Text>
                            </View>
                        </View>
                    </View>
                )}

                <View style={styles.stampSignatureRow}>
                    <View style={styles.stampBox}>
                        <Text style={styles.stampText}>BANK'S STAMP</Text>
                    </View>
                    <View style={styles.signatureLineContainer}>
                        <View style={styles.signatureLine}>
                            <Text style={styles.signatureText}>HEAD OF INSTITUTION</Text>
                        </View>
                    </View>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 5, borderTopWidth: 0.5, borderTopColor: '#efefef', paddingTop: 2 }}>
                    <Text style={[styles.generatedBy, { flex: 1, marginTop: 0, borderTopWidth: 0, paddingTop: 0, textAlign: 'left' }]}>
                        GENERATED BY {details.generatedBy.fullName}{`\n`}{details.generatedBy.timestampStr}
                    </Text>
                </View>
            </View>
        </View>
    </View>
);

export const FeeChallanPDF = ({ student, details, fees, totalAmount, siblings, showDiscount, paidStamp, arrearsHistory, installmentsHistory, paymentHistory, qrUrl }: FeeChallanPDFProps) => (
    <Document>
        <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page} wrap>
            {/* Left 85% for the 3 Challan Copies.
                Absolutely positioned so it sits outside normal flow — it renders on page 1 only
                and never participates in pagination, leaving the history column free to overflow
                onto page 2 on its own. The height must be explicit (not `bottom: 0`, which would
                resolve against the unbounded document height and split the copies across pages).

                The nesting is deliberate: react-pdf still counts an absolute box's overflow when
                deciding page breaks, so the OUTER box is sized to the flow area to avoid forcing
                a spurious extra page, while the INNER box is given the full content height so the
                copies still occupy the whole page. The inner overflow is purely visual. */}
            <View style={{ position: 'absolute', top: 0, left: 0, width: CHALLAN_WIDTH, height: CONTENT_HEIGHT - QR_RESERVE }}>
                <View style={{ position: 'absolute', top: CHALLAN_TOP_OFFSET, left: 0, width: '100%', height: CONTENT_HEIGHT - CHALLAN_TOP_OFFSET, flexDirection: 'row' }}>
                    <ChallanCopy copyType="Bank Copy" student={student} details={details} fees={fees} totalAmount={totalAmount} showDiscount={showDiscount} paidStamp={paidStamp} siblings={siblings} />
                    <ChallanCopy copyType="School Copy" student={student} details={details} fees={fees} totalAmount={totalAmount} showDiscount={showDiscount} paidStamp={paidStamp} siblings={siblings} />
                    <ChallanCopy copyType="Student Copy" student={student} details={details} fees={fees} totalAmount={totalAmount} showDiscount={showDiscount} paidStamp={paidStamp} siblings={siblings} isLast={true} />
                </View>
            </View>

            {/* Right 15% for the 4th Column - History & Metadata.
                The only child in normal flow, so this is what paginates. `marginLeft: '85%'`
                (rather than being a flex sibling) is what holds it in the right-hand slot on
                page 2, where the challan block no longer exists. The QR strip is reserved by the
                Page's paddingBottom, and the left divider is drawn as a fixed rule below, so
                neither depends on how far the content happens to flow. */}
            <View style={{ marginLeft: CHALLAN_WIDTH, width: COLUMN_WIDTH, paddingLeft: 8, flexDirection: 'column' }}>

                {/* ARREAR'S HISTORY */}
                <View style={styles.historySection} wrap={isLong(arrearsHistory)}>
                    <Text style={styles.historyTitle}>ARREAR'S HISTORY</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [1, 2, 1];
                            return (
                                <>
                                    <View fixed={isLong(arrearsHistory)}>
                                        <HRow cols={COLS} variant="header" cells={[
                                            { node: 'MONTH' }, { node: 'FEE' }, { node: 'AMOUNT', align: 'right' },
                                        ]} />
                                    </View>
                                    {arrearsHistory && arrearsHistory.length > 0 ? (() => {
                                        const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                                        // `monthLabel` is resolved by prepareVoucherPdfData, which knows the
                                        // term each head was written under (student_fees.term_start_month).
                                        // This component only ever saw the student's *current* class, so it
                                        // could not label a head billed before a move between term systems.
                                        // The date fallback is for legacy rows with no month/year.
                                        const getMonthLabel = (r: any) => {
                                            if (r.monthLabel) return r.monthLabel;
                                            const [y, m] = r.date.split('-');
                                            return `${MONTHS_SHORT[parseInt(m) - 1].toUpperCase()} ${y.slice(-2)}`;
                                        };
                                        let runningTotal = 0;
                                        return (
                                            <>
                                                {arrearsHistory.map((a: any, idx: number) => {
                                                    const amt = parseFloat(String(a.amount).replace(/,/g, '')) || 0;
                                                    runningTotal += amt;
                                                    return (
                                                        <HRow key={idx} cols={COLS} cells={[
                                                            { node: getMonthLabel(a) },
                                                            { node: a.head },
                                                            { node: amt.toLocaleString(), align: 'right' },
                                                        ]} />
                                                    );
                                                })}
                                                <HRow cols={[3, 1]} variant="total" cells={[
                                                    { node: 'TOTAL OUTSTANDING' },
                                                    { node: runningTotal.toLocaleString(), align: 'right' },
                                                ]} />
                                            </>
                                        );
                                    })() : (
                                        <HRow cols={COLS} last cells={[{ node: '-' }, { node: '-' }, { node: '-', align: 'right' }]} />
                                    )}
                                </>
                            );
                        })()}
                    </View>
                </View>

                {/* PAYMENT HISTORY */}
                <View style={styles.historySection} wrap={isLong(paymentHistory)}>
                    <Text style={styles.historyTitle}>PAYMENT HISTORY</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [0.95, 1.9, 0.8, 0.75];
                            return (
                                <>
                                    <View fixed={isLong(paymentHistory)}>
                                        <HRow cols={COLS} variant="header" cells={[
                                            { node: 'DATE' }, { node: 'HEAD' }, { node: 'METHOD' }, { node: 'AMOUNT', align: 'right' },
                                        ]} />
                                    </View>
                                    {paymentHistory && paymentHistory.length > 0 ? (
                                        <>
                                            {paymentHistory.map((p: any, idx: number) => {
                                                const [y, m, d] = String(p.date || '').split('-');
                                                const dateLabel = y && m && d ? `${d}/${m}/${y}` : (p.date || 'N/A');
                                                const tint = p.isDiscount ? '#16a34a' : undefined;
                                                return (
                                                    <HRow key={idx} cols={COLS} cells={[
                                                        { node: dateLabel },
                                                        { node: p.head || '-', color: tint },
                                                        { node: p.isDiscount ? '-' : formatPaymentMethod(p.payment_method) },
                                                        { node: p.amount || '0', align: 'right', color: tint },
                                                    ]} />
                                                );
                                            })}
                                            <HRow cols={[3.65, 0.75]} variant="total" cells={[
                                                { node: 'TOTAL PAID' },
                                                { node: paymentHistory[paymentHistory.length - 1]?.totalAmount || '0', align: 'right' },
                                            ]} />
                                        </>
                                    ) : (
                                        <HRow cols={COLS} last cells={[{ node: '-' }, { node: '-' }, { node: '-' }, { node: '-', align: 'right' }]} />
                                    )}
                                </>
                            );
                        })()}
                    </View>
                </View>

                {/* INSTALLMENTS PLAN */}
                <View style={styles.historySection} wrap={isLong(installmentsHistory)}>
                    <Text style={styles.historyTitle}>INSTALLMENTS PLAN</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [1.1, 1.9, 0.95, 1.05];
                            return (
                                <>
                                    <View fixed={isLong(installmentsHistory)}>
                                        <HRow cols={COLS} variant="header" cells={[
                                            { node: 'MONTH' }, { node: 'HEAD' }, { node: 'AMOUNT', align: 'right' }, { node: 'STATUS', align: 'right' },
                                        ]} />
                                    </View>
                                    {installmentsHistory && installmentsHistory.length > 0 ? (() => {
                                        const planTotal = installmentsHistory.reduce((s: number, i: any) => s + Number(i.amount || 0), 0);
                                        return (
                                            <>
                                                {installmentsHistory.map((inst: any, idx: number) => (
                                                    <HRow key={idx} cols={COLS} cells={[
                                                        { node: inst.month },
                                                        { node: inst.head },
                                                        { node: Number(inst.amount || 0).toLocaleString(), align: 'right' },
                                                        { node: inst.status, align: 'right', color: inst.status === 'PAID' ? '#16a34a' : '#dc2626' },
                                                    ]} />
                                                ))}
                                                <HRow cols={[3.95, 1.05]} variant="total" cells={[
                                                    { node: 'TOTAL' },
                                                    { node: planTotal.toLocaleString(), align: 'right' },
                                                ]} />
                                            </>
                                        );
                                    })() : (
                                        <HRow cols={COLS} last cells={[{ node: '-' }, { node: '-' }, { node: '-', align: 'right' }, { node: '-', align: 'right' }]} />
                                    )}
                                </>
                            );
                        })()}
                    </View>
                </View>

                {/* SIBLINGS Section */}
                <View style={styles.historySection} wrap={isLong(siblings)}>
                    <Text style={styles.historyTitle}>SIBLINGS</Text>
                    <View style={styles.historyTable}>
                        {(() => {
                            const COLS = [0.85, 1.05, 0.9, 2.0, 1.2];
                            return (
                                <>
                                    <View fixed={isLong(siblings)}>
                                        <HRow cols={COLS} variant="header" cells={[
                                            { node: 'CC' }, { node: 'GR' }, { node: 'LVL' }, { node: 'NAME' }, { node: 'STATUS' },
                                        ]} />
                                    </View>
                                    {siblings && siblings.length > 0 ? (
                                        siblings.map((s, idx) => (
                                            <HRow key={idx} cols={COLS} last={idx === siblings.length - 1} cells={[
                                                { node: s.cc }, { node: s.gr_number }, { node: s.className },
                                                { node: s.full_name }, { node: s.status || 'Active' },
                                            ]} />
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

            {/* Divider between the challan copies and the history column. Drawn as a fixed rule
                rather than a border on the column so it spans the full page height on every
                page, regardless of how far the column's content flows. */}
            <View fixed style={{ position: 'absolute', top: 0, left: CHALLAN_WIDTH, width: 1, height: CONTENT_HEIGHT, backgroundColor: '#e4e4e4' }} />

            {/* QR CODE — scans directly to the challan PDF.
                `fixed` + absolute keeps it anchored to the bottom of the history column on
                every page. It sits outside the column (as a direct Page child) so the column's
                own pagination can't push it around, and is positioned from the top so it lands
                exactly in the strip reserved by the Page's paddingBottom. */}
            {qrUrl && (
                <View fixed style={{ position: 'absolute', top: CONTENT_HEIGHT - QR_RESERVE, height: QR_RESERVE, left: CHALLAN_WIDTH, width: COLUMN_WIDTH, paddingLeft: 8, alignItems: 'center', paddingTop: 6, borderTopWidth: 0.5, borderTopColor: '#e2e8f0' }}>
                    <QrCodeView url={qrUrl} size={52} />
                    <Text style={{ fontSize: 4, color: '#334155', marginTop: 2, textAlign: 'center', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.3 }}>Scan to open PDF</Text>
                </View>
            )}
        </Page>
    </Document>
);
