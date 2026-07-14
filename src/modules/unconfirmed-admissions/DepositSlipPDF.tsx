import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image } from '@react-pdf/renderer';
import path from 'path';
import fs from 'fs';

const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');
let LOGO_BUFFER: Buffer | null = null;
try {
  LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
} catch (e) {
  // Fallback if logo not found
}

// Styling mirrors FeeChallanPDF (voucher-pdf module) so the deposit slip
// reads as the same document family as a paid fee voucher.
const styles = StyleSheet.create({
  page: {
    backgroundColor: '#ffffff',
    padding: 14,
    fontSize: 8,
    fontFamily: 'Helvetica',
  },
  // Dashed frame around the whole printable area = outer trim/cut guide.
  cutFrame: {
    flex: 1,
    flexDirection: 'row',
    borderWidth: 0.75,
    borderColor: '#94a3b8',
    borderStyle: 'dashed',
  },
  section: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    position: 'relative',
    // Center vertical dashed line = the cut line separating the two copies.
    borderRightWidth: 1,
    borderRightColor: '#334155',
    borderRightStyle: 'dashed',
  },
  lastSection: {
    borderRightWidth: 0,
  },
  copyLabel: {
    position: 'absolute',
    right: 14,
    top: -2,
    backgroundColor: '#000000',
    color: '#ffffff',
    padding: '2px 7px',
    fontSize: 7,
    fontWeight: 'bold',
    borderRadius: 2,
    textTransform: 'uppercase',
  },
  paidStamp: {
    position: 'absolute',
    top: '42%',
    left: '5%',
    width: '90%',
    textAlign: 'center',
    color: '#16a34a',
    fontSize: 52,
    fontWeight: 'bold',
    opacity: 0.22,
    transform: 'rotate(-32deg)',
    letterSpacing: 6,
    fontFamily: 'Helvetica-Bold',
  },
  header: {
    flexDirection: 'column',
    marginBottom: 5,
    alignItems: 'center',
    textAlign: 'center',
  },
  logo: {
    width: 42,
    height: 42,
    marginBottom: 3,
  },
  schoolInfo: {
    alignItems: 'center',
    marginBottom: 3,
  },
  schoolName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1a1a1a',
    letterSpacing: 0.2,
  },
  schoolAddress: {
    fontSize: 7,
    color: '#333333',
    marginTop: 1,
  },
  studentSection: {
    flexDirection: 'column',
    backgroundColor: '#f9f9f9',
    padding: 6,
    borderRadius: 4,
    marginBottom: 6,
    borderWidth: 0.5,
    borderColor: '#555555',
    gap: 3,
  },
  studentCol: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 7,
    textTransform: 'uppercase',
    color: '#333333',
    fontWeight: 'bold',
  },
  value: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#1a1a1a',
  },
  sectionLabelRow: {
    backgroundColor: '#f8fafc',
    paddingVertical: 2,
    paddingHorizontal: 3,
    marginTop: 4,
    marginBottom: 3,
    borderLeftWidth: 2,
    borderLeftColor: '#94a3b8',
    borderLeftStyle: 'solid',
  },
  sectionLabel: {
    fontSize: 6.5,
    fontWeight: 'bold',
    color: '#334155',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  guardianTable: {
    width: '100%',
    marginBottom: 4,
  },
  guardianTableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#333333',
    paddingBottom: 1,
    marginBottom: 1,
  },
  guardianTableRow: {
    flexDirection: 'row',
    paddingVertical: 1.5,
    borderBottomWidth: 0.3,
    borderBottomColor: '#f0f0f0',
  },
  gCellName: { flex: 2, fontSize: 7.5 },
  gCellRelation: { flex: 1, fontSize: 7.5 },
  gCellCnic: { flex: 1.5, fontSize: 7.5 },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderTopWidth: 0.5,
    borderTopColor: '#333333',
    borderBottomWidth: 0.5,
    borderBottomColor: '#333333',
    backgroundColor: '#f8fafc',
  },
  totalLabel: {
    fontSize: 8.5,
    fontWeight: 'bold',
    color: '#021A54',
  },
  totalValue: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#021A54',
  },
  footerContainer: {
    marginTop: 'auto',
    paddingTop: 6,
  },
  notesContainer: {
    backgroundColor: '#f8fafc',
    padding: 5,
    marginBottom: 5,
    borderWidth: 0.5,
    borderColor: '#cbd5e1',
    borderRadius: 2,
  },
  notesLabel: {
    fontSize: 6.5,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 1,
  },
  notesText: {
    fontSize: 7,
    color: '#1a1a1a',
    fontWeight: 'bold',
  },
  stampSignatureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    marginBottom: 3,
  },
  stampBox: {
    width: 70,
    height: 26,
    borderWidth: 1,
    borderColor: '#999999',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stampText: {
    fontSize: 6.5,
    color: '#333333',
    fontWeight: 'bold',
  },
  signatureLineContainer: {
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  signatureLine: {
    width: 100,
    borderTopWidth: 0.5,
    borderTopColor: '#333333',
    paddingTop: 3,
    alignItems: 'center',
  },
  signatureText: {
    fontSize: 6.5,
    color: '#333333',
    fontWeight: 'bold',
  },
  generatedBy: {
    fontSize: 6,
    color: '#333333',
    textAlign: 'center',
    marginTop: 6,
    borderTopWidth: 0.5,
    borderTopColor: '#efefef',
    paddingTop: 3,
  },
});

interface DepositSlipPDFProps {
  data: {
    cc: number;
    fullName: string;
    dateOfBirth: string;
    age: string;
    gender: string;
    address?: string;
    campusName?: string;
    academicSystem?: string;
    requestedGrade?: string;
    depositAmount: string;
    guardians: Array<{
      name: string;
      relation: string;
      cnic?: string;
    }>;
    adminNotes?: string;
    createdBy?: string;
    createdAt: string;
  };
}

const SlipCopy = ({ copyType, data, isLast }: { copyType: string; data: DepositSlipPDFProps['data']; isLast?: boolean }) => (
  <View style={[styles.section, isLast ? styles.lastSection : {}]}>
    <Text style={styles.copyLabel}>{copyType}</Text>

    <View style={styles.header}>
      {LOGO_BUFFER && (
        <Image style={styles.logo} src={{ data: LOGO_BUFFER, format: 'png' }} />
      )}
      <View style={styles.schoolInfo}>
        <Text style={styles.schoolName}>THE AMERICAN FOUNDATION SCHOOL</Text>
        <Text style={styles.schoolAddress}>{data.campusName || 'Main Campus'}</Text>
        <Text style={styles.schoolAddress}>QUICK ADMISSION — DEPOSIT SLIP</Text>
      </View>
    </View>

    <View style={styles.studentSection}>
      <View style={styles.studentCol}>
        <View style={{ flex: 3.5 }}>
          <Text style={styles.label}>Candidate Name</Text>
          <Text style={styles.value}>{data.fullName.toUpperCase()}</Text>
        </View>
        <View style={{ minWidth: 50, flexShrink: 0, alignItems: 'flex-end' }}>
          <Text style={[styles.label, { textAlign: 'right' }]}>Gender</Text>
          <Text style={[styles.value, { textAlign: 'right' }]}>{data.gender.toUpperCase()}</Text>
        </View>
      </View>
      <View style={styles.studentCol}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Computer Code</Text>
          <Text style={styles.value}>{data.cc}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>D.O.B</Text>
          <Text style={styles.value}>{data.dateOfBirth}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Age at Reg.</Text>
          <Text style={styles.value}>{data.age}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={[styles.label, { textAlign: 'right' }]}>Date</Text>
          <Text style={[styles.value, { textAlign: 'right' }]}>{data.createdAt}</Text>
        </View>
      </View>
      <View style={styles.studentCol}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>System</Text>
          <Text style={styles.value}>{data.academicSystem || 'N/A'}</Text>
        </View>
        <View style={{ flex: 1.5, alignItems: 'flex-end' }}>
          <Text style={[styles.label, { textAlign: 'right' }]}>Class Applying For</Text>
          <Text style={[styles.value, { textAlign: 'right' }]}>{data.requestedGrade || 'N/A'}</Text>
        </View>
      </View>
      {data.address && (
        <View style={{ marginTop: 2, borderTopWidth: 0.5, borderTopColor: '#efefef', paddingTop: 2 }}>
          <Text style={styles.label}>Address</Text>
          <Text style={[styles.value, { fontSize: 7.5 }]}>{data.address}</Text>
        </View>
      )}
    </View>

    {data.guardians && data.guardians.length > 0 && (
      <>
        <View style={styles.sectionLabelRow}>
          <Text style={styles.sectionLabel}>Guardian Information</Text>
        </View>
        <View style={styles.guardianTable}>
          <View style={styles.guardianTableHeader}>
            <Text style={[styles.gCellName, { fontWeight: 'bold' }]}>NAME</Text>
            <Text style={[styles.gCellRelation, { fontWeight: 'bold' }]}>RELATION</Text>
            <Text style={[styles.gCellCnic, { fontWeight: 'bold', textAlign: 'right' }]}>CNIC</Text>
          </View>
          {data.guardians.map((g, index) => (
            <View key={index} style={styles.guardianTableRow}>
              <Text style={styles.gCellName}>{g.name}</Text>
              <Text style={styles.gCellRelation}>{g.relation || 'N/A'}</Text>
              <Text style={[styles.gCellCnic, { textAlign: 'right' }]}>{g.cnic || 'N/A'}</Text>
            </View>
          ))}
        </View>
      </>
    )}

    <View style={styles.totalRow}>
      <Text style={styles.totalLabel}>DEPOSIT AMOUNT RECEIVED</Text>
      <Text style={styles.totalValue}>PKR {data.depositAmount}</Text>
    </View>

    <View style={styles.footerContainer}>
      {copyType === 'SCHOOL COPY' && data.adminNotes && (
        <View style={styles.notesContainer}>
          <Text style={styles.notesLabel}>INTERNAL NOTE (BACK OFFICE ONLY):</Text>
          <Text style={styles.notesText}>{data.adminNotes}</Text>
        </View>
      )}

      <View style={styles.stampSignatureRow}>
        <View style={styles.stampBox}>
          <Text style={styles.stampText}>SCHOOL STAMP</Text>
        </View>
        <View style={styles.signatureLineContainer}>
          <View style={styles.signatureLine}>
            <Text style={styles.signatureText}>AUTHORIZED SIGNATORY</Text>
          </View>
        </View>
      </View>

      <Text style={styles.generatedBy}>
        GENERATED BY {data.createdBy || 'SYSTEM'}{`\n`}{data.createdAt}
      </Text>
    </View>

    {/* Rendered last so the watermark paints ON TOP of all content. */}
    <Text style={styles.paidStamp}>PAID</Text>
  </View>
);

export const DepositSlipPDF: React.FC<DepositSlipPDFProps> = ({ data }) => (
  <Document>
    <Page size="A4" orientation="landscape" style={styles.page}>
      <View style={styles.cutFrame}>
        <SlipCopy copyType="SCHOOL COPY" data={data} />
        <SlipCopy copyType="CANDIDATE COPY" data={data} isLast />
      </View>
    </Page>
  </Document>
);
