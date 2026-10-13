import React from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { SchoolSheet, SchoolSheetOptions } from './school-report-sheet';

/**
 * TAFSD-306: the PDF twin of the school-format Excel (school-report-sheet.ts).
 * Same title block, columns and TOTAL row, built from the very same sheets, so
 * the two can't disagree. One page run per campus; the table header repeats on
 * every page of it.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 24, paddingBottom: 30, paddingHorizontal: 22, fontFamily: 'Times-Roman', fontSize: 7, color: '#000' },
  banner: { textAlign: 'center', fontFamily: 'Times-Bold' },
  school: { fontSize: 14, marginBottom: 2 },
  classes: { fontSize: 9, marginBottom: 2 },
  title: { fontSize: 12, marginBottom: 2 },
  campus: { fontSize: 11, marginBottom: 1 },
  session: { fontSize: 10, marginBottom: 6 },
  dayDate: { fontFamily: 'Helvetica-Bold', fontSize: 7, marginBottom: 1 },
  period: { fontSize: 10, marginTop: 6, marginBottom: 2 },
  filter: { fontSize: 8, marginBottom: 1 },
  table: { marginTop: 6, borderTopWidth: 0.6, borderLeftWidth: 0.6, borderColor: '#000' },
  row: { flexDirection: 'row' },
  cell: { borderRightWidth: 0.6, borderBottomWidth: 0.6, borderColor: '#000', paddingVertical: 2, paddingHorizontal: 2, textAlign: 'center', justifyContent: 'center' },
  head: { fontFamily: 'Times-Bold', fontSize: 7, backgroundColor: '#f2f2f2' },
  totalLabel: { fontFamily: 'Times-Bold', fontSize: 8 },
  totalValue: { fontFamily: 'Times-Bold', fontSize: 7.5 },
  footer: { position: 'absolute', bottom: 12, left: 22, right: 22, flexDirection: 'row', justifyContent: 'space-between', fontSize: 6.5, color: '#555' },
});

const fmtMoney = (n: number, decimals: boolean) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0 });

export interface SchoolReportPdfProps {
  sheets: SchoolSheet[];
  opts: SchoolSheetOptions;
  dayLine: string;
  dateLine: string;
}

export const SchoolReportPDF: React.FC<SchoolReportPdfProps> = ({ sheets, opts, dayLine, dateLine }) => {
  const columns = [{ header: 'S#', key: '__sno', width: 5 } as SchoolSheetOptions['columns'][number], ...opts.columns];
  const widthTotal = columns.reduce((s, c) => s + c.width, 0);
  const pct = (w: number) => `${((w / widthTotal) * 100).toFixed(3)}%`;

  return (
    <Document title={opts.reportTitle} author="The American Foundation School">
      {sheets.map((sheet, si) => {
        const decimals = new Map(
          columns
            .filter((c) => c.money)
            .map((c) => [c.key, sheet.rows.some((r) => typeof r[c.key] === 'number' && !Number.isInteger(r[c.key]))]),
        );
        const sums = new Map<string, number>();
        for (const r of sheet.rows)
          for (const c of columns) if (c.total && typeof r[c.key] === 'number') sums.set(c.key, (sums.get(c.key) ?? 0) + (r[c.key] as number));
        const firstTotal = columns.findIndex((c) => c.total);
        const show = (c: (typeof columns)[number], v: unknown) =>
          v === undefined || v === null ? '' : c.money && typeof v === 'number' ? fmtMoney(v, decimals.get(c.key)!) : String(v);

        return (
          <Page key={si} size="A4" orientation="landscape" style={styles.page} wrap>
            <Text style={[styles.banner, styles.school]}>{opts.heading.school}</Text>
            {opts.heading.classesLine ? <Text style={[styles.banner, styles.classes]}>{opts.heading.classesLine}</Text> : null}
            <Text style={[styles.banner, styles.title]}>{opts.reportTitle}</Text>
            <Text style={[styles.banner, styles.campus]}>{sheet.campus}</Text>
            <Text style={[styles.banner, styles.session]}>{opts.heading.session}</Text>
            <Text style={styles.dayDate}>{dayLine}</Text>
            <Text style={styles.dayDate}>{dateLine}</Text>
            <Text style={[styles.banner, styles.period]}>{opts.periodLine}</Text>
            {opts.filterLines.map((l, i) => (
              <Text key={i} style={[styles.banner, styles.filter]}>{l}</Text>
            ))}

            <View style={styles.table}>
              <View style={styles.row} fixed>
                {columns.map((c) => (
                  <Text key={c.key} style={[styles.cell, styles.head, { width: pct(c.width) }]}>{c.header.toUpperCase()}</Text>
                ))}
              </View>
              {sheet.rows.map((r, i) => (
                <View key={i} style={styles.row} wrap={false}>
                  {columns.map((c) => (
                    <Text key={c.key} style={[styles.cell, { width: pct(c.width) }]}>
                      {c.key === '__sno' ? String(i + 1) : show(c, r[c.key])}
                    </Text>
                  ))}
                </View>
              ))}
              {firstTotal >= 0 && sheet.rows.length > 0 ? (
                <View style={styles.row} wrap={false}>
                  {firstTotal > 0 ? (
                    <Text style={[styles.cell, styles.totalLabel, { width: pct(columns.slice(0, firstTotal).reduce((s, c) => s + c.width, 0)) }]}>
                      TOTAL
                    </Text>
                  ) : null}
                  {columns.slice(firstTotal).map((c) => (
                    <Text key={c.key} style={[styles.cell, styles.totalValue, { width: pct(c.width) }]}>
                      {c.total ? (c.money ? fmtMoney(Math.round((sums.get(c.key) ?? 0) * 100) / 100, decimals.get(c.key)!) : String(sums.get(c.key) ?? 0)) : ''}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>

            <View style={styles.footer} fixed>
              <Text>{`${opts.reportTitle} · ${sheet.campus}`}</Text>
              <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
            </View>
          </Page>
        );
      })}
    </Document>
  );
};
