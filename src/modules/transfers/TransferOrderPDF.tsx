import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image } from '@react-pdf/renderer';
import * as path from 'path';

const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');

const styles = StyleSheet.create({
    page: { padding: 30, backgroundColor: '#ffffff', fontFamily: 'Helvetica', fontSize: 9, color: '#000000' },
    outerBorder: { borderWidth: 4, borderColor: '#8B0000', flex: 1, padding: 8 },
    innerBorder: { borderWidth: 1, borderColor: '#000000', flex: 1, padding: 10 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    logo: { width: 58, height: 58, flexShrink: 0 },
    titleContainer: { alignItems: 'center', flex: 1, marginHorizontal: 6 },
    title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#0047AB', textTransform: 'uppercase', letterSpacing: 1.5 },
    schoolName: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#8B0000', textTransform: 'uppercase', textAlign: 'center', marginTop: 3, letterSpacing: 0.5 },
    campusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
    campusLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' },
    campusValue: { fontSize: 8, fontFamily: 'Helvetica-Bold', borderBottomWidth: 1, borderBottomColor: '#000', paddingLeft: 4, minWidth: 60, minHeight: 10 },
    photoContainer: { width: 72, height: 82, borderWidth: 1, borderColor: '#000', flexShrink: 0, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
    studentPhoto: { width: '100%', height: '100%', objectFit: 'cover' },
    topMetaSection: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, marginBottom: 6 },
    metaLeft: { flex: 1 },
    metaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
    metaLabel: { fontFamily: 'Helvetica-Bold', fontSize: 8, width: 45 },
    metaValue: { fontSize: 8, borderBottomWidth: 0.5, borderBottomColor: '#000', flex: 1, paddingLeft: 3, minHeight: 10 },
    fromRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
    fromLabel: { fontFamily: 'Helvetica-Bold', fontSize: 7.5, marginRight: 2 },
    divider: { borderBottomWidth: 0.5, borderBottomColor: '#000', marginBottom: 6 },
    identifierRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 16 },
    identifierItem: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    idLabel: { fontFamily: 'Helvetica-Bold', fontSize: 8, marginRight: 3 },
    idValue: { fontSize: 8, borderBottomWidth: 0.5, borderBottomColor: '#000', flex: 1, paddingLeft: 3, minHeight: 10 },
    transferRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 8 },
    transferItem: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    transferLabel: { fontFamily: 'Helvetica-Bold', fontSize: 7.5, marginRight: 3 },
    transferValue: { fontSize: 8, borderBottomWidth: 0.5, borderBottomColor: '#000', flex: 1, paddingLeft: 3, minHeight: 10 },
    detailRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    detailLabel: { fontFamily: 'Helvetica-Bold', fontSize: 8, marginRight: 5 },
    detailValue: { fontSize: 8, borderBottomWidth: 0.5, borderBottomColor: '#000', flex: 1, paddingLeft: 4, minHeight: 10 },
    multiRow: { flexDirection: 'row', marginBottom: 6, gap: 12 },
    flexItem: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    checkbox: { width: 9, height: 9, borderWidth: 1, borderColor: '#000', marginLeft: 4, marginRight: 6 },
    checkboxFilled: { backgroundColor: '#000' },
    footer: { marginTop: 'auto', paddingTop: 4 },
    copiesToText: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', textAlign: 'center', marginBottom: 6, borderTopWidth: 0.5, borderTopColor: '#000', paddingTop: 4 },
    ccListItem: { fontSize: 7.5, marginBottom: 1 },
    segmentHeadRow: { flexDirection: 'row', alignItems: 'center' },
    signatureSection: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 28 },
    stampBox: { width: 80, height: 40, borderWidth: 0.5, borderColor: '#aaa', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center' },
    stampLabel: { fontSize: 7, color: '#aaa', textTransform: 'uppercase' },
    signatureBlock: { alignItems: 'center', minWidth: 130 },
    signatureLine: { borderTopWidth: 1, borderTopColor: '#000', width: '100%', paddingTop: 3, alignItems: 'center' },
    signatureName: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', textAlign: 'center' },
    signatureTitle: { fontSize: 7, textAlign: 'center' },
});

const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
        return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
    } catch { return dateStr; }
};

export interface TransferOrderPDFData {
    day?: string;
    date?: string;
    cc: number | string;
    gr_number?: string | null;
    reg_number?: string | null;
    campus_name?: string | null;
    campus_number?: string | null;
    full_name: string;
    father_name?: string | null;
    dob?: string | null;
    gender?: string | null;
    date_of_transfer?: string | null;
    scholastic_year?: string | null;
    academic_year?: string | null;
    class_name?: string | null;
    section_name?: string | null;
    remarks_inline?: string | null;
    address?: string | null;
    home_phone?: string | null;
    fax?: string | null;
    father_cell?: string | null;
    mother_cell?: string | null;
    nearest_phone?: string | null;
    nearest_name?: string | null;
    nearest_relationship?: string | null;
    email?: string | null;
    remarks_footer?: string | null;
    segment_head?: string | null;
    transfer_from?: string | null;
    transfer_to?: string | null;
    discipline?: string | null;
    photograph_url?: string | null;
}

export const TransferOrderPDF = ({ data }: { data: TransferOrderPDFData }) => {
    const isMale = data.gender?.toUpperCase() === 'MALE';
    const isFemale = data.gender?.toUpperCase() === 'FEMALE';

    return (
        <Document>
            <Page size="A4" style={styles.page}>
                <View style={styles.outerBorder}>
                    <View style={styles.innerBorder}>

                        {/* HEADER */}
                        <View style={styles.header}>
                            <Image src={LOGO_PATH} style={styles.logo} />
                            <View style={styles.titleContainer}>
                                <Text style={styles.title}>TRANSFER ORDER</Text>
                                <Text style={styles.schoolName}>THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES</Text>
                                <View style={styles.campusRow}>
                                    <Text style={styles.campusLabel}>CAMPUS - </Text>
                                    <Text style={styles.campusValue}>{data.campus_number || data.campus_name || ''}</Text>
                                </View>
                            </View>
                            {data.photograph_url ? (
                                <View style={styles.photoContainer}><Image src={data.photograph_url} style={styles.studentPhoto} /></View>
                            ) : (
                                <View style={styles.photoContainer}><Text style={{ fontSize: 7, color: '#999' }}>PHOTO</Text></View>
                            )}
                        </View>

                        {/* DAY / DATE */}
                        <View style={styles.topMetaSection}>
                            <View style={styles.metaLeft}>
                                <View style={styles.metaRow}><Text style={styles.metaLabel}>DAY :</Text><Text style={styles.metaValue}>{data.day}</Text></View>
                                <View style={styles.metaRow}><Text style={styles.metaLabel}>DATE :</Text><Text style={styles.metaValue}>{data.date}</Text></View>
                                <View style={styles.fromRow}><Text style={styles.fromLabel}>FROM : ADMISSION REGISTRAR</Text></View>
                            </View>
                        </View>

                        <View style={styles.divider} />

                        {/* REG / CC / GR */}
                        <View style={styles.identifierRow}>
                            <View style={styles.identifierItem}><Text style={styles.idLabel}>REG. # </Text><Text style={styles.idValue}>{data.reg_number}</Text></View>
                            <View style={styles.identifierItem}><Text style={styles.idLabel}>C.C. # </Text><Text style={styles.idValue}>{String(data.cc)}</Text></View>
                            <View style={styles.identifierItem}><Text style={styles.idLabel}>G.R. # </Text><Text style={styles.idValue}>{data.gr_number}</Text></View>
                        </View>

                        {/* TRANSFER FROM / TO / DISCIPLINE */}
                        <View style={styles.transferRow}>
                            <View style={styles.transferItem}><Text style={styles.transferLabel}>TRANSFER FROM :</Text><Text style={styles.transferValue}>{data.transfer_from}</Text></View>
                            <View style={styles.transferItem}><Text style={styles.transferLabel}>TRANSFER TO :</Text><Text style={styles.transferValue}>{data.transfer_to}</Text></View>
                            <View style={styles.transferItem}><Text style={styles.transferLabel}>DISCIPLINE :</Text><Text style={styles.transferValue}>{data.discipline}</Text></View>
                        </View>

                        <View style={styles.divider} />

                        {/* STUDENT DETAILS */}
                        <View style={styles.detailRow}><Text style={styles.detailLabel}>STUDENT'S NAME :</Text><Text style={styles.detailValue}>{data.full_name}</Text></View>
                        <View style={styles.detailRow}><Text style={styles.detailLabel}>FATHER'S NAME :</Text><Text style={styles.detailValue}>{data.father_name}</Text></View>

                        <View style={styles.multiRow}>
                            <View style={styles.flexItem}>
                                <Text style={styles.detailLabel}>DATE OF BIRTH :</Text>
                                <Text style={styles.detailValue}>{formatDate(data.dob)}</Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                                <Text style={styles.detailLabel}>GENDER : MALE</Text>
                                <View style={[styles.checkbox, isMale ? styles.checkboxFilled : {}]} />
                                <Text style={[styles.detailLabel, { marginLeft: 6 }]}>FEMALE</Text>
                                <View style={[styles.checkbox, isFemale ? styles.checkboxFilled : {}]} />
                            </View>
                        </View>

                        <View style={styles.multiRow}>
                            <View style={styles.flexItem}><Text style={styles.detailLabel}>DATE OF TRANSFER :</Text><Text style={styles.detailValue}>{data.date_of_transfer}</Text></View>
                            <View style={styles.flexItem}><Text style={styles.detailLabel}>SCHOLASTIC YEAR :</Text><Text style={styles.detailValue}>{data.scholastic_year || data.academic_year}</Text></View>
                        </View>

                        <View style={styles.multiRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 2 }}><Text style={styles.detailLabel}>CLASS IN WHICH ALLOCATED :</Text><Text style={styles.detailValue}>{data.class_name}</Text></View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}><Text style={styles.detailLabel}>SECTION :</Text><Text style={styles.detailValue}>{data.section_name}</Text></View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1.5 }}><Text style={styles.detailLabel}>REMARKS :</Text><Text style={styles.detailValue}>{data.remarks_inline}</Text></View>
                        </View>

                        <View style={styles.detailRow}><Text style={styles.detailLabel}>PERMANENT ADDRESS # :</Text><Text style={styles.detailValue}>{data.address}</Text></View>

                        <View style={styles.multiRow}>
                            <View style={styles.flexItem}><Text style={styles.detailLabel}>HOME PHONE # :</Text><Text style={styles.detailValue}>{data.home_phone}</Text></View>
                            <View style={styles.flexItem}><Text style={styles.detailLabel}>FAX # :</Text><Text style={styles.detailValue}>{data.fax}</Text></View>
                        </View>

                        <View style={styles.multiRow}>
                            <View style={styles.flexItem}><Text style={styles.detailLabel}>CELLULAR # ( FATHER'S ) :</Text><Text style={styles.detailValue}>{data.father_cell}</Text></View>
                            <View style={styles.flexItem}><Text style={styles.detailLabel}>CELLULAR # ( MOTHER'S ) :</Text><Text style={styles.detailValue}>{data.mother_cell}</Text></View>
                        </View>

                        <View style={styles.multiRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}><Text style={styles.detailLabel}>NEAREST # :</Text><Text style={styles.detailValue}>{data.nearest_phone}</Text></View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1.2 }}><Text style={styles.detailLabel}>NAME :</Text><Text style={styles.detailValue}>{data.nearest_name}</Text></View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1.8 }}><Text style={styles.detailLabel}>RELATIONSHIP WITH CHILD :</Text><Text style={styles.detailValue}>{data.nearest_relationship}</Text></View>
                        </View>

                        <View style={styles.detailRow}><Text style={styles.detailLabel}>E-MAIL ADDRESS :</Text><Text style={styles.detailValue}>{data.email}</Text></View>

                        {/* FOOTER */}
                        <View style={styles.footer}>
                            <Text style={styles.copiesToText}>COPIES TO : PERSONAL FILE / PARENTS / ACCOUNTS DEPARTMENT / SCHOOL LIST</Text>
                            <View style={styles.detailRow}><Text style={styles.detailLabel}>REMARKS (IF ANY)</Text><Text style={styles.detailValue}>{data.remarks_footer}</Text></View>

                            <View>
                                <Text style={[styles.ccListItem, { fontFamily: 'Helvetica-Bold' }]}>C.C. TO;</Text>
                                <Text style={styles.ccListItem}>C.E.O.</Text>
                                <Text style={styles.ccListItem}>M.D.</Text>
                                <Text style={styles.ccListItem}>H.R.D.</Text>
                                <Text style={styles.ccListItem}>SYSTEM ANALYST</Text>
                                <View style={styles.segmentHeadRow}>
                                    <Text style={styles.ccListItem}>SEGMENT HEAD - </Text>
                                    <Text style={[styles.ccListItem, { borderBottomWidth: 0.5, borderBottomColor: '#000', minWidth: 100, paddingLeft: 3 }]}>{data.segment_head}</Text>
                                </View>
                            </View>

                            <View style={styles.signatureSection}>
                                <View style={styles.stampBox}><Text style={styles.stampLabel}>School Stamp</Text></View>
                                <View style={styles.signatureBlock}>
                                    <View style={styles.signatureLine}>
                                        <Text style={styles.signatureName}>MRS. ASIEA SOMROO</Text>
                                        <Text style={styles.signatureTitle}>DEPUTY DIRECTRESS A. & P. - G</Text>
                                    </View>
                                </View>
                                <View style={styles.signatureBlock}>
                                    <View style={styles.signatureLine}>
                                        <Text style={styles.signatureName}>MRS. FOZIA HUSSAIN</Text>
                                        <Text style={styles.signatureTitle}>DIRECTRESS A. & P. - G</Text>
                                    </View>
                                </View>
                            </View>
                        </View>

                    </View>
                </View>
            </Page>
        </Document>
    );
};
