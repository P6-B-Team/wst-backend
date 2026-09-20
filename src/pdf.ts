import PDFDocument from 'pdfkit';

/**
 * PDF generation for the exports the brief asks for (CSV/PDF). Deliberately plain: identifiers,
 * amounts and dates stay LTR so an Arabic UI can display the same document without reordering them.
 */

const money = (n: any) => Number(n ?? 0).toFixed(2);

export function invoiceStatementPdf(s: any) {
  const doc = new PDFDocument({ margin: 46, size: 'A4' });

  doc.fontSize(18).text('Invoice Statement', { align: 'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#555')
    .text(`Invoice ${s.invoiceNo}  ·  Status ${s.status}  ·  Issued ${new Date(s.issuedAt).toISOString().slice(0, 10)}`);
  doc.fillColor('#000').moveDown(1);

  doc.fontSize(11).text('Customer & vehicle', { underline: true });
  doc.fontSize(10)
    .text(`Customer : ${s.job?.customer_name ?? '-'}   ${s.job?.phone ?? ''}`)
    .text(`Job card : ${s.job?.job_no ?? '-'}`)
    .text(`Vehicle  : ${s.job?.make ?? ''} ${s.job?.model ?? ''}  ·  Plate ${s.job?.plate_no ?? '-'}  ·  VIN ${s.job?.vin ?? '-'}`)
    .text(`Complaint: ${s.job?.complaint ?? '-'}`);
  doc.moveDown(1);

  doc.fontSize(11).text('Lines', { underline: true });
  doc.moveDown(0.3).fontSize(9);
  for (const l of s.lines) {
    doc.text(
      `${String(l.source_type).padEnd(7)} ${String(l.description).slice(0, 52).padEnd(54)} ${String(Number(l.quantity)).padStart(6)} x ${money(l.unit_price).padStart(9)} = ${money(l.line_total).padStart(10)}`
    );
  }
  doc.moveDown(1).fontSize(10);

  const t = s.totals;
  doc.text(`Parts subtotal : ${money(t.parts)}`);
  doc.text(`Labor subtotal : ${money(t.labor)}`);
  doc.text(`Sublet         : ${money(t.sublet)}`);
  doc.text(`Discount       : ${money(t.discount)}`);
  doc.text(`Tax (${(Number(t.taxRate) * 100).toFixed(2)}%)   : ${money(t.tax)}`);
  doc.fontSize(12).text(`TOTAL          : ${money(t.total)}`);
  doc.fontSize(10).text(`Paid           : ${money(t.paid)}`);
  doc.text(`Outstanding    : ${money(t.outstanding)}`);

  doc.moveDown(1).fontSize(8).fillColor('#666')
    .text(`Reconciliation — lines total ${money(s.reconciliation.linesTotal)} equals computed subtotals ${money(s.reconciliation.subtotalsTotal)}.`)
    .text('Totals are computed from logged labour, issued parts and sublet records; they are never typed in.');

  doc.end();
  return doc;
}

/** Generic tabular export used by /exports/:dataset?format=pdf */
export function tablePdf(title: string, rows: any[]) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  doc.fontSize(16).text(title);
  doc.fontSize(8).fillColor('#555').text(`Generated ${new Date().toISOString()}  ·  ${rows.length} rows`).fillColor('#000');
  doc.moveDown(0.6);

  if (!rows.length) {
    doc.fontSize(10).text('No rows for the selected filters.');
    doc.end();
    return doc;
  }
  const cols = Object.keys(rows[0]);
  doc.fontSize(8).text(cols.map((c) => c.slice(0, 18).padEnd(20)).join(''));
  doc.moveTo(doc.x, doc.y).lineTo(780, doc.y).stroke();
  for (const r of rows.slice(0, 400)) {
    doc.text(cols.map((c) => String(r[c] ?? '').slice(0, 18).padEnd(20)).join(''));
  }
  if (rows.length > 400) doc.moveDown(0.5).text(`… ${rows.length - 400} more rows, use format=csv for the full dataset.`);
  doc.end();
  return doc;
}
