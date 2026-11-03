import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { TFunction } from "i18next";
import type { InvoicePdfModel } from "./invoice-model";

const styles = StyleSheet.create({
  page: { padding: 36, paddingBottom: 64, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  muted: { color: "#555" },
  bold: { fontFamily: "Helvetica-Bold" },
  parties: { flexDirection: "row", gap: 24, marginBottom: 14 },
  party: { flex: 1 },
  partyLabel: { fontSize: 8, color: "#555", marginBottom: 2, textTransform: "uppercase" },
  meta: { flexDirection: "row", gap: 18, marginBottom: 12 },
  tableHead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#111",
    paddingBottom: 3,
    fontFamily: "Helvetica-Bold",
  },
  row: { flexDirection: "row", paddingVertical: 3, borderBottomWidth: 0.5, borderColor: "#ccc" },
  cDesc: { flex: 5, paddingRight: 6 },
  note: { fontSize: 8, color: "#555", marginTop: 1 },
  cQty: { flex: 1.4, textAlign: "right", paddingRight: 6 },
  cPrice: { flex: 2, textAlign: "right", paddingRight: 6 },
  cVat: { flex: 2, textAlign: "right", paddingRight: 6 },
  cAmount: { flex: 2, textAlign: "right" },
  section: { marginTop: 14 },
  sectionTitle: { fontFamily: "Helvetica-Bold", marginBottom: 3 },
  totals: { marginTop: 12, alignSelf: "flex-end", width: 260 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  due: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 2 },
  footer: { position: "absolute", left: 36, right: 36, bottom: 24, fontSize: 7.5, color: "#555" },
  pageNumber: { textAlign: "right", marginTop: 2 },
});

/** The courtesy-copy invoice PDF. Strings come ready formatted from `buildInvoicePdfModel`. */
export function InvoiceDocument({ model, t }: { model: InvoicePdfModel; t: TFunction }) {
  return (
    <Document title={`${model.title} ${model.numberLine}`} author={model.issuerName}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{model.title}</Text>
            <Text>{model.numberLine}</Text>
          </View>
          <View>
            {model.meta.map((row) => (
              <Text key={row.label}>
                <Text style={styles.muted}>{row.label}: </Text>
                {row.value}
              </Text>
            ))}
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>{t("pdf.issuer")}</Text>
            <Text style={styles.bold}>{model.issuerName}</Text>
            {model.issuerLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>{t("pdf.client")}</Text>
            <Text style={styles.bold}>{model.clientName}</Text>
            {model.clientLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </View>
        </View>

        {model.linked ? <Text style={{ marginBottom: 8 }}>{model.linked}</Text> : null}

        <View style={styles.tableHead}>
          <Text style={styles.cDesc}>{t("pdf.columns.description")}</Text>
          <Text style={styles.cQty}>{t("pdf.columns.quantity")}</Text>
          <Text style={styles.cPrice}>{t("pdf.columns.unitPrice")}</Text>
          <Text style={styles.cVat}>{t("pdf.columns.vat")}</Text>
          <Text style={styles.cAmount}>{t("pdf.columns.amount")}</Text>
        </View>
        {model.lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id and never reorder
          <View key={index} style={styles.row} wrap={false}>
            <View style={styles.cDesc}>
              <Text>{line.description}</Text>
              {line.note ? <Text style={styles.note}>{line.note}</Text> : null}
            </View>
            <Text style={styles.cQty}>{line.quantity}</Text>
            <Text style={styles.cPrice}>{line.unitPrice}</Text>
            <Text style={styles.cVat}>{line.vat}</Text>
            <Text style={styles.cAmount}>{line.amount}</Text>
          </View>
        ))}

        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>{t("pdf.summary.title")}</Text>
          <View style={styles.tableHead}>
            <Text style={styles.cVat}>{t("pdf.summary.rate")}</Text>
            <Text style={styles.cPrice}>{t("pdf.summary.taxable")}</Text>
            <Text style={styles.cAmount}>{t("pdf.summary.vat")}</Text>
          </View>
          {model.groups.map((group) => (
            <View key={group.rate} style={styles.row}>
              <Text style={styles.cVat}>{group.rate}</Text>
              <Text style={styles.cPrice}>{group.taxable}</Text>
              <Text style={styles.cAmount}>{group.vat}</Text>
            </View>
          ))}
        </View>

        {model.naturaTexts.length > 0 ? (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>{t("pdf.naturaTitle")}</Text>
            {model.naturaTexts.map((natura) => (
              <Text key={natura.code}>
                {natura.code}: {natura.text}
              </Text>
            ))}
          </View>
        ) : null}

        {model.noteLines.length > 0 ? (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>{t("pdf.noteTitle")}</Text>
            {model.noteLines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: note lines never reorder
              <Text key={index}>{line || " "}</Text>
            ))}
          </View>
        ) : null}

        <View style={styles.totals} wrap={false}>
          {model.totals.map((row) => (
            <View key={row.label} style={styles.totalRow}>
              <Text style={row.strong ? styles.due : undefined}>{row.label}</Text>
              <Text style={row.strong ? styles.due : undefined}>{row.value}</Text>
            </View>
          ))}
          {model.ritenuta ? <Text style={styles.muted}>{model.ritenuta}</Text> : null}
        </View>

        {model.payment.length > 0 ? (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>{t("pdf.payment.title")}</Text>
            {model.payment.map((row) => (
              <Text key={row.label}>
                <Text style={styles.muted}>{row.label}: </Text>
                {row.value}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>{model.legalNote}</Text>
          <Text
            style={styles.pageNumber}
            render={({ pageNumber, totalPages }) => t("pdf.page", { pageNumber, totalPages })}
          />
        </View>
      </Page>
    </Document>
  );
}
