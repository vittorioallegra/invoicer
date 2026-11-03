import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { TFunction } from "i18next";
import type { InvoicePdfModel } from "./invoice-model";

const styles = StyleSheet.create({
  page: { padding: 36, paddingBottom: 64, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  header: { marginBottom: 18 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  previewMark: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#b00020",
    borderWidth: 1,
    borderColor: "#b00020",
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  previewNote: { fontFamily: "Helvetica-Bold", color: "#b00020", marginBottom: 2 },
  muted: { color: "#555" },
  bold: { fontFamily: "Helvetica-Bold" },
  parties: { flexDirection: "row", gap: 24, marginBottom: 28 },
  party: { flex: 1 },
  partyLabel: { fontSize: 8, color: "#555", marginBottom: 2, textTransform: "uppercase" },
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
  bottom: { marginTop: "auto", paddingTop: 16, flexDirection: "row", gap: 24 },
  paymentBlock: { flex: 1 },
  totals: { width: 280 },
  totalRow: { flexDirection: "row", paddingVertical: 1.5 },
  // A long label (a cassa or ritenuta description) wraps inside its own column, never under the amount.
  totalLabel: { flex: 1, paddingRight: 10 },
  totalValue: { flexShrink: 0, textAlign: "right" },
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
          <View style={styles.titleRow}>
            <Text style={styles.title}>{model.title}</Text>
            {model.previewMark ? <Text style={styles.previewMark}>{model.previewMark}</Text> : null}
          </View>
          <Text>{model.numberLine}</Text>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>{t("pdf.sender")}</Text>
            <Text style={styles.bold}>{model.issuerName}</Text>
            {model.issuerLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>{t("pdf.recipient")}</Text>
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

        {/* Payment and totals sit at the bottom of the last page and never split across pages. */}
        <View style={styles.bottom} wrap={false}>
          <View style={styles.paymentBlock}>
            {model.payment.length > 0 ? (
              <>
                <Text style={styles.sectionTitle}>{t("pdf.payment.title")}</Text>
                {model.payment.map((row) => (
                  <Text key={row.label}>
                    <Text style={styles.muted}>{row.label}: </Text>
                    {row.value}
                  </Text>
                ))}
              </>
            ) : null}
          </View>
          <View style={styles.totals}>
            {model.totals.map((row) => (
              <View key={row.label} style={styles.totalRow}>
                <Text style={row.strong ? [styles.totalLabel, styles.due] : styles.totalLabel}>
                  {row.label}
                </Text>
                <Text style={row.strong ? [styles.totalValue, styles.due] : styles.totalValue}>
                  {row.value}
                </Text>
              </View>
            ))}
            {model.ritenuta ? <Text style={styles.muted}>{model.ritenuta}</Text> : null}
          </View>
        </View>

        <View style={styles.footer} fixed>
          {model.previewNote ? <Text style={styles.previewNote}>{model.previewNote}</Text> : null}
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
