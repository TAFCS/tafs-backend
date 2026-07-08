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

const styles = StyleSheet.create({
  page: {
    padding: 30,
    fontSize: 9,
    fontFamily: 'Helvetica',
    backgroundColor: '#ffffff',
  },
  slipContainer: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  slip: {
    borderWidth: 1,
    borderColor: '#021A54',
    borderRadius: 8,
    padding: 15,
    marginBottom: 20,
    position: 'relative',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1.5,
    borderBottomColor: '#021A54',
    paddingBottom: 8,
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logo: {
    width: 40,
    height: 40,
  },
  titleContainer: {
    flexDirection: 'column',
  },
  schoolName: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: '#021A54',
  },
  subTitle: {
    fontSize: 8,
    color: '#333333',
    marginTop: 2,
  },
  slipLabelContainer: {
    backgroundColor: '#021A54',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  slipLabelText: {
    color: '#ffffff',
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
  },
  refContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  refText: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: '#021A54',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  col: {
    width: '50%',
    paddingVertical: 3,
    flexDirection: 'row',
    alignItems: 'center',
  },
  fullCol: {
    width: '100%',
    paddingVertical: 3,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  fieldLabel: {
    fontFamily: 'Helvetica-Bold',
    color: '#555555',
    width: '35%',
    fontSize: 8,
  },
  fieldValue: {
    color: '#111111',
    width: '65%',
    fontSize: 9,
  },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: '#021A54',
    borderBottomWidth: 0.5,
    borderBottomColor: '#021A54',
    paddingBottom: 2,
    marginTop: 8,
    marginBottom: 6,
  },
  depositBox: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 6,
    padding: 10,
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  depositTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: '#D56637',
  },
  depositValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: '#021A54',
  },
  footer: {
    marginTop: 15,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 0.5,
    borderTopColor: '#cccccc',
    paddingTop: 8,
  },
  footerText: {
    fontSize: 7,
    color: '#666666',
  },
  signatureLine: {
    width: 100,
    borderTopWidth: 1,
    borderTopColor: '#333333',
    marginTop: 15,
    textAlign: 'center',
    fontSize: 8,
    paddingTop: 3,
    color: '#555555',
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#555555',
    borderBottomStyle: 'dashed',
    marginVertical: 15,
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
    depositAmount: string;
    guardians: Array<{
      name: string;
      relation: string;
      cnic?: string;
    }>;
    createdAt: string;
  };
}

export const DepositSlipPDF: React.FC<DepositSlipPDFProps> = ({ data }) => {
  const renderSlip = (copyName: string) => (
    <View style={styles.slip}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {LOGO_BUFFER && (
            <Image style={styles.logo} src={{ data: LOGO_BUFFER, format: 'png' }} />
          )}
          <View style={styles.titleContainer}>
            <Text style={styles.schoolName}>THE ADAMJEE TAFS SCHOOL</Text>
            <Text style={styles.subTitle}>Quick Admission Form - Deposit Slip</Text>
          </View>
        </View>
        <View style={styles.slipLabelContainer}>
          <Text style={styles.slipLabelText}>{copyName}</Text>
        </View>
      </View>

      {/* References */}
      <View style={styles.refContainer}>
        <Text style={styles.refText}>Reference CC: {data.cc}</Text>
        <Text style={{ fontSize: 8, color: '#666666' }}>Date: {data.createdAt}</Text>
      </View>

      {/* Candidate Personal Data */}
      <Text style={styles.sectionTitle}>CANDIDATE PERSONAL DATA</Text>
      <View style={styles.grid}>
        <View style={styles.col}>
          <Text style={styles.fieldLabel}>FULL NAME:</Text>
          <Text style={styles.fieldValue}>{data.fullName.toUpperCase()}</Text>
        </View>
        <View style={styles.col}>
          <Text style={styles.fieldLabel}>CAMPUS:</Text>
          <Text style={styles.fieldValue}>{data.campusName || 'N/A'}</Text>
        </View>
        <View style={styles.col}>
          <Text style={styles.fieldLabel}>D.O.B:</Text>
          <Text style={styles.fieldValue}>{data.dateOfBirth}</Text>
        </View>
        <View style={styles.col}>
          <Text style={styles.fieldLabel}>AGE AT REG:</Text>
          <Text style={styles.fieldValue}>{data.age}</Text>
        </View>
        <View style={styles.col}>
          <Text style={styles.fieldLabel}>GENDER:</Text>
          <Text style={styles.fieldValue}>{data.gender.toUpperCase()}</Text>
        </View>
        {data.address && (
          <View style={styles.fullCol}>
            <Text style={[styles.fieldLabel, { width: '17.5%' }]}>ADDRESS:</Text>
            <Text style={[styles.fieldValue, { width: '82.5%' }]}>{data.address}</Text>
          </View>
        )}
      </View>

      {/* Guardian Background if provided */}
      {data.guardians && data.guardians.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>GUARDIAN INFORMATION</Text>
          {data.guardians.map((g: any, index: number) => (
            <View key={index} style={[styles.grid, { marginBottom: 4, borderBottomWidth: index < data.guardians.length - 1 ? 0.3 : 0, borderBottomColor: '#cccccc', paddingBottom: 2 }]}>
              <View style={styles.col}>
                <Text style={styles.fieldLabel}>NAME:</Text>
                <Text style={styles.fieldValue}>{g.name}</Text>
              </View>
              <View style={styles.col}>
                <Text style={styles.fieldLabel}>RELATION:</Text>
                <Text style={styles.fieldValue}>{g.relation || 'N/A'}</Text>
              </View>
              <View style={styles.col}>
                <Text style={styles.fieldLabel}>CNIC:</Text>
                <Text style={styles.fieldValue}>{g.cnic || 'N/A'}</Text>
              </View>
            </View>
          ))}
        </>
      )}

      {/* Deposit Amount Details */}
      <View style={styles.depositBox}>
        <Text style={styles.depositTitle}>REQUIRED DEPOSIT AMOUNT:</Text>
        <Text style={styles.depositValue}>PKR {data.depositAmount}</Text>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Note: This is an unconfirmed admission deposit slip. Use the Reference CC to complete Form 1.
        </Text>
        <View style={styles.signatureLine}>
          <Text>Authorized Signature</Text>
        </View>
      </View>
    </View>
  );

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.slipContainer}>
          {renderSlip('SCHOOL COPY')}
          <View style={styles.divider} />
          {renderSlip('CANDIDATE COPY')}
        </View>
      </Page>
    </Document>
  );
};
