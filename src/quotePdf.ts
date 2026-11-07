import type { Quote } from "./pricing.js";

export function renderQuotePdf(quote: Quote, details: { jobId: string; note?: string }): Buffer {
  const lines: string[] = [];
  const draw = (text: string) => lines.push(text);
  draw("0.039 0.039 0.039 rg");
  draw("0 0 595 842 re f");
  draw("0.922 0 0.545 rg");
  draw("0 800 595 42 re f");
  text(draw, "F1", 22, 48, 760, "0.961 0.949 0.914", "BLACKCAT MAKERLAB");
  text(draw, "F2", 12, 48, 738, "0.922 0 0.545", "3D PRINTING & FABRICATION");
  text(draw, "F2", 11, 48, 708, "0.722 0.706 0.659", "Quote");
  text(draw, "F2", 10, 48, 690, "0.541 0.525 0.463", `Job ${details.jobId}`);
  let y = 660;
  for (const line of quote.lines) {
    const raw = money(line.rawEur);
    const net = money(line.netEur);
    const adjustment = line.adjustment === "line_minimum" ? `  line minimum ${net}` : "";
    text(draw, "F2", 12, 48, y, "0.722 0.706 0.659", `${line.label}  ${line.grams.toFixed(2)} g at EUR ${line.rateEurPerGram.toFixed(2)}/g`);
    y -= 16;
    text(draw, "F2", 12, 48, y, "0.961 0.949 0.914", `Raw ${raw}${adjustment}`);
    y -= 22;
  }
  const rows: Array<[string, string]> = [
    [quote.minimumOrderApplied ? "Order minimum applied" : "Order minimum not needed", money(quote.minimumOrderEur)],
    ["Subtotal before VAT", money(quote.subtotalEur)],
    [`VAT ${Math.round(quote.vatRate * 100)}%`, money(quote.vatEur)],
    ["Total", money(quote.totalEur)],
  ];
  for (const [label, value] of rows) {
    text(draw, "F2", 12, 48, y, "0.722 0.706 0.659", label);
    text(draw, "F1", 12, 400, y, "0.961 0.949 0.914", value);
    y -= 18;
  }
  y -= 8;
  text(draw, "F2", 11, 48, y, "0.541 0.525 0.463", quote.shipping.note);
  text(draw, "F2", 10, 48, 92, "0.541 0.525 0.463", "MakerLab - 3D printing & fabrication - a BlackCat lab");
  text(draw, "F2", 10, 48, 76, "0.541 0.525 0.463", "labs@blackcat.eu.com   blackcat.eu.com   +356 9921 4462");
  text(draw, "F2", 10, 48, 60, "0.541 0.525 0.463", "BlackCat Studios 71, First Floor, Triq l-Imdina, QRM9019, Malta");
  text(draw, "F2", 10, 48, 44, "0.541 0.525 0.463", "VAT MT31422627");
  return wrapPdf(lines.join("\n"));
}

function money(value: number): string {
  return `EUR ${value.toFixed(2)}`;
}

function text(draw: (line: string) => void, font: string, size: number, x: number, y: number, rgb: string, value: string): void {
  draw("BT");
  draw(`${rgb} rg`);
  draw(`/${font} ${size} Tf`);
  draw(`1 0 0 1 ${x} ${y} Tm`);
  draw(`(${escapePdf(value)}) Tj`);
  draw("ET");
}

function escapePdf(value: string): string {
  return value.replace(/[\\()]/g, (char) => `\\${char}`);
}

function wrapPdf(stream: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
