import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image, Font, Svg, Rect } from '@react-pdf/renderer';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';

const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');
const LOGO_BUFFER = fs.readFileSync(LOGO_PATH);

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

// Define styles
const styles = StyleSheet.create({
    page: {
        flexDirection: 'row',
        backgroundColor: '#ffffff',
        paddingHorizontal: 5,
        paddingVertical: 6,
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
        top: -5,
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
        top: '35%',
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
        borderBottomWidth: 0.5,
        borderBottomColor: '#475569',
        paddingVertical: 1,
    },
    historyTableRow: {
        flexDirection: 'row',
        borderBottomWidth: 0.3,
        borderBottomColor: '#64748b',
        paddingVertical: 1,
    },
    historyTableCell: {
        fontSize: 4,
        color: '#1e293b',
        flex: 1,
        borderRightWidth: 0.3,
        borderRightColor: '#475569',
        paddingHorizontal: 2,
    },
    historyTableHeaderCell: {
        fontSize: 4,
        fontWeight: 'bold',
        color: '#1e293b',
        flex: 1,
        borderRightWidth: 0.3,
        borderRightColor: '#475569',
        paddingHorizontal: 2,
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
                    const hasDiscount = showDiscount !== false && fee.discount && fee.discount > 0;

                    if (isMTF && hasDiscount) {
                        return (
                            <React.Fragment key={i}>
                                <View style={[styles.tableRow, { borderBottomWidth: 0, paddingBottom: 0.5 }]}>
                                    <Text style={styles.colDesc}>{fee.description}</Text>
                                    <Text style={styles.colAmount}>
                                        {fee.amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </Text>
                                </View>
                                <View style={[styles.tableRow, { borderBottomWidth: 0, paddingBottom: 0.5 }]}>
                                    <Text style={[styles.colDesc, { color: '#16a34a' }]}>{`DISCOUNT ON ${fee.description}`}</Text>
                                    <Text style={[styles.colAmount, { color: '#16a34a' }]}>
                                        -{fee.discount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </Text>
                                </View>
                                <View style={styles.tableRow}>
                                    <Text style={[styles.colDesc, { fontWeight: 'bold' }]}>{`${fee.description} AFTER DISCOUNT`}</Text>
                                    <Text style={[styles.colAmount, { fontWeight: 'bold' }]}>
                                        {effectiveNet.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </Text>
                                </View>
                            </React.Fragment>
                        );
                    }

                    return (
                        <View key={i} style={styles.tableRow}>
                            <Text style={styles.colDesc}>{fee.description}</Text>
                            <Text style={styles.colAmount}>
                                {effectiveNet.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </Text>
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
        <Page size={[841.89, 595.28]} wrap={false} style={styles.page}>
            {/* Left 85% for the 3 Challan Copies */}
            <View style={{ width: '85%', flexDirection: 'row' }}>
                <ChallanCopy copyType="Bank Copy" student={student} details={details} fees={fees} totalAmount={totalAmount} showDiscount={showDiscount} paidStamp={paidStamp} siblings={siblings} />
                <ChallanCopy copyType="School Copy" student={student} details={details} fees={fees} totalAmount={totalAmount} showDiscount={showDiscount} paidStamp={paidStamp} siblings={siblings} />
                <ChallanCopy copyType="Student Copy" student={student} details={details} fees={fees} totalAmount={totalAmount} showDiscount={showDiscount} paidStamp={paidStamp} siblings={siblings} isLast={true} />
            </View>

            {/* Right 15% for the 4th Column - History & Metadata */}
            <View style={{ width: '15%', paddingLeft: 8, borderLeftWidth: 1, borderLeftColor: '#e4e4e4', borderLeftStyle: 'solid', flexDirection: 'column', height: '100%' }}>

                {/* ARREAR'S HISTORY */}
                <View style={styles.historySection}>
                    <Text style={styles.historyTitle}>ARREAR'S HISTORY</Text>
                    <View style={styles.historyTable}>
                        <View style={styles.historyTableHeader}>
                            <Text style={styles.historyTableHeaderCell}>MONTH</Text>
                            <Text style={[styles.historyTableHeaderCell, { flex: 2 }]}>FEE</Text>
                            <Text style={[styles.historyTableHeaderCell, { textAlign: 'right' }]}>AMOUNT</Text>
                        </View>
                        {arrearsHistory && arrearsHistory.length > 0 ? (() => {
                            const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                            // Apr–Mar classes (IDs 15–19): term starts in April (cutoff=4).
                            // All others: Aug–Jul term (cutoff=8).
                            const termCutoff = [15, 16, 17, 18, 19].includes(student?.class_id) ? 4 : 8;
                            const getMonthLabel = (r: any) => {
                                if (r.target_month && r.academic_year) {
                                    const parts = r.academic_year.split('-');
                                    const year = r.target_month >= termCutoff ? parts[0] : parts[1];
                                    return `${MONTHS_SHORT[r.target_month - 1].toUpperCase()} ${year.slice(-2)}`;
                                }
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
                                            <View key={idx} style={styles.historyTableRow}>
                                                <Text style={styles.historyTableCell}>{getMonthLabel(a)}</Text>
                                                <Text style={[styles.historyTableCell, { flex: 2 }]}>{a.head}</Text>
                                                <Text style={[styles.historyTableCell, { textAlign: 'right' }]}>{amt.toLocaleString()}</Text>
                                            </View>
                                        );
                                    })}
                                    <View style={{ flexDirection: 'row', backgroundColor: '#1e293b', paddingHorizontal: 2, paddingVertical: 1.5, marginTop: 1 }}>
                                        <Text style={[styles.historyTableCell, { fontWeight: 'bold', color: '#ffffff', flex: 3 }]}>TOTAL OUTSTANDING</Text>
                                        <Text style={[styles.historyTableCell, { fontWeight: 'bold', color: '#ffffff', textAlign: 'right' }]}>
                                            {runningTotal.toLocaleString()}
                                        </Text>
                                    </View>
                                </>
                            );
                        })() : (
                            <View style={styles.historyTableRow}>
                                <Text style={styles.historyTableCell}>-</Text>
                                <Text style={[styles.historyTableCell, { flex: 2 }]}>-</Text>
                                <Text style={[styles.historyTableCell, { textAlign: 'right' }]}>-</Text>
                            </View>
                        )}
                    </View>
                </View>
                
                {/* PAYMENT HISTORY */}
                <View style={styles.historySection}>
                    <Text style={styles.historyTitle}>PAYMENT HISTORY</Text>
                    <View style={styles.historyTable}>
                        <View style={styles.historyTableHeader}>
                            <Text style={styles.historyTableHeaderCell}>DATE</Text>
                            <Text style={[styles.historyTableHeaderCell, { flex: 2 }]}>HEAD</Text>
                            <Text style={[styles.historyTableHeaderCell, { textAlign: 'right' }]}>AMOUNT</Text>
                        </View>
                        {paymentHistory && paymentHistory.length > 0 ? (
                            <>
                                {paymentHistory.map((p: any, idx: number) => (
                                    <View key={idx} style={styles.historyTableRow}>
                                        <Text style={styles.historyTableCell}>{(() => {
                                            const [y, m, d] = String(p.date || '').split('-');
                                            return y && m && d ? `${d}/${m}/${y}` : (p.date || 'N/A');
                                        })()}</Text>
                                        <Text style={[styles.historyTableCell, { flex: 2 }]}>{p.head || '-'}</Text>
                                        <Text style={[styles.historyTableCell, { textAlign: 'right' }]}>{p.amount || '0'}</Text>
                                    </View>
                                ))}
                                <View style={{ flexDirection: 'row', backgroundColor: '#1e293b', paddingHorizontal: 2, paddingVertical: 1.5, marginTop: 1 }}>
                                    <Text style={[styles.historyTableCell, { fontWeight: 'bold', color: '#ffffff', flex: 3 }]}>TOTAL PAID</Text>
                                    <Text style={[styles.historyTableCell, { fontWeight: 'bold', color: '#ffffff', textAlign: 'right' }]}>{paymentHistory[paymentHistory.length - 1]?.totalAmount || '0'}</Text>
                                </View>
                            </>
                        ) : (
                            <View style={styles.historyTableRow}>
                                <Text style={styles.historyTableCell}>-</Text>
                                <Text style={[styles.historyTableCell, { flex: 2 }]}>-</Text>
                                <Text style={[styles.historyTableCell, { textAlign: 'right' }]}>-</Text>
                            </View>
                        )}
                    </View>
                </View>

                {/* INSTALLMENTS PLAN */}
                <View style={styles.historySection}>
                    <Text style={styles.historyTitle}>INSTALLMENTS PLAN</Text>
                    <View style={styles.historyTable}>
                        <View style={styles.historyTableHeader}>
                            <Text style={[styles.historyTableHeaderCell, { flex: 1.2 }]}>MONTH</Text>
                            <Text style={[styles.historyTableHeaderCell, { flex: 2 }]}>HEAD</Text>
                            <Text style={[styles.historyTableHeaderCell, { flex: 1, textAlign: 'right' }]}>AMOUNT</Text>
                            <Text style={[styles.historyTableHeaderCell, { flex: 0.8, textAlign: 'right' }]}>STATUS</Text>
                        </View>
                        {installmentsHistory && installmentsHistory.length > 0 ? (() => {
                            const planTotal = installmentsHistory.reduce((s: number, i: any) => s + Number(i.amount || 0), 0);
                            return (
                                <>
                                    {installmentsHistory.map((inst: any, idx: number) => (
                                        <View key={idx} style={styles.historyTableRow}>
                                            <Text style={[styles.historyTableCell, { flex: 1.2 }]}>{inst.month}</Text>
                                            <Text style={[styles.historyTableCell, { flex: 2 }]}>{inst.head}</Text>
                                            <Text style={[styles.historyTableCell, { flex: 1, textAlign: 'right' }]}>
                                                {Number(inst.amount || 0).toLocaleString()}
                                            </Text>
                                            <Text style={[styles.historyTableCell, { flex: 0.8, textAlign: 'right', color: inst.status === 'PAID' ? '#16a34a' : '#dc2626' }]}>
                                                {inst.status}
                                            </Text>
                                        </View>
                                    ))}
                                    <View style={{ flexDirection: 'row', backgroundColor: '#1e293b', paddingHorizontal: 2, paddingVertical: 1.5, marginTop: 1 }}>
                                        <Text style={[styles.historyTableCell, { fontWeight: 'bold', color: '#ffffff', flex: 3.2 }]}>TOTAL</Text>
                                        <Text style={[styles.historyTableCell, { fontWeight: 'bold', color: '#ffffff', textAlign: 'right', flex: 0.8 }]}>
                                            {planTotal.toLocaleString()}
                                        </Text>
                                    </View>
                                </>
                            );
                        })() : (
                            <View style={styles.historyTableRow}>
                                <Text style={[styles.historyTableCell, { flex: 1.2 }]}>-</Text>
                                <Text style={[styles.historyTableCell, { flex: 2 }]}>-</Text>
                                <Text style={[styles.historyTableCell, { flex: 1, textAlign: 'right' }]}>-</Text>
                                <Text style={[styles.historyTableCell, { flex: 0.8, textAlign: 'right' }]}>-</Text>
                            </View>
                        )}
                    </View>
                </View>

                {/* SIBLINGS Section */}
                <View style={styles.historySection}>
                    <Text style={styles.historyTitle}>SIBLINGS</Text>
                    <View style={styles.historyTable}>
                        <View style={styles.historyTableHeader}>
                            <Text style={styles.historyTableHeaderCell}>CC</Text>
                            <Text style={styles.historyTableHeaderCell}>GR</Text>
                            <Text style={styles.historyTableHeaderCell}>LVL</Text>
                            <Text style={[styles.historyTableHeaderCell, { flex: 2.2 }]}>NAME</Text>
                            <Text style={styles.historyTableHeaderCell}>STATUS</Text>
                        </View>
                        {siblings && siblings.length > 0 ? (
                            siblings.map((s, idx) => (
                                <View key={idx} style={styles.historyTableRow}>
                                    <Text style={styles.historyTableCell}>{s.cc}</Text>
                                    <Text style={styles.historyTableCell}>{s.gr_number}</Text>
                                    <Text style={styles.historyTableCell}>{s.className}</Text>
                                    <Text style={[styles.historyTableCell, { flex: 2.2 }]}>{s.full_name}</Text>
                                    <Text style={styles.historyTableCell}>{s.status || 'Active'}</Text>
                                </View>
                            ))
                        ) : (
                            <View style={styles.historyTableRow}>
                                <Text style={[styles.historyTableCell, { textAlign: 'center', flex: 1, fontStyle: 'italic', fontSize: 3.5 }]}>No siblings</Text>
                            </View>
                        )}
                    </View>
                </View>

                {/* QR CODE — scans directly to the challan PDF */}
                {qrUrl && (
                    <View style={{ marginTop: 'auto', alignItems: 'center', paddingTop: 6, borderTopWidth: 0.5, borderTopColor: '#e2e8f0' }}>
                        <QrCodeView url={qrUrl} size={52} />
                        <Text style={{ fontSize: 4, color: '#334155', marginTop: 2, textAlign: 'center', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.3 }}>Scan to open PDF</Text>
                    </View>
                )}
            </View>
        </Page>
    </Document>
);
