import { deflateSync } from "node:zlib";

/**
 * Minimal dependency-free PDF 1.4 generator. Only used for meeting exports;
 * output is a single linear document with one object stream per page.
 */

const PAGE_WRAP = 92;
const LINES_PER_PAGE = 58;
const FONT = "Helvetica";
const FONT_SIZE = 10;

/** Escapes a text line for a PDF literal string (WinAnsi/Latin-1 bytes). */
function pdfEscape(line: string): string {
  let out = "";
  for (const char of line) {
    const code = char.codePointAt(0) ?? 32;
    if (code === 92) out += "\\\\";
    else if (code === 40) out += "\\(";
    else if (code === 41) out += "\\)";
    else if (code <= 31 || (code >= 128 && code <= 159)) out += " ";
    else if (code <= 255) out += char;
    else out += " ";
  }
  return out;
}

/** Greedy word wrap to a maximum visual width. */
function wrapLine(line: string, width: number): string[] {
  const words = line.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function chunk(lines: string[]): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  return pages.length > 0 ? pages : [[]];
}

function contentStream(lines: string[]): string {
  const parts = [`BT`, `/F1 ${FONT_SIZE} Tf`, `40 780 Td`];
  for (const line of lines) {
    parts.push(`(${pdfEscape(line)}) Tj`, `0 ${-FONT_SIZE - 3} Td`);
  }
  parts.push("ET");
  return parts.join("\n");
}

/** Renders a reusable multi-page PDF buffer from wrapped text lines. */
export function renderPdf(rawLines: string[]): Buffer {
  const wrapped: string[] = [];
  for (const raw of rawLines) {
    for (const line of raw.split("\n")) {
      wrapped.push(...wrapLine(line, PAGE_WRAP));
    }
  }

  const pages = chunk(wrapped);
  const contentBuffers = pages.map((page) => {
    const stream = contentStream(page);
    return deflateSync(Buffer.from(stream, "latin1"));
  });

  // Object layout: 1 Catalog, 2 Pages, 3 Font, then (Page, Contents) per page.
  const objects = new Map<number, Buffer>();
  const write = (number: number, body: string): void => {
    objects.set(number, Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, "latin1"));
  };

  const pageCount = pages.length;
  const pageKids: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageRef = 4 + i * 2;
    const contentRef = pageRef + 1;
    pageKids.push(`${pageRef} 0 R`);
    write(pageRef, `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 3 0 R>>>> /Contents ${contentRef} 0 R>>`);
    const payload = contentBuffers[i];
    if (!payload) throw new Error(`missing pdf content for page ${i}`);
    write(contentRef, `<</Length ${payload.length} /Filter /FlateDecode>>\nstream\n${payload.toString("latin1")}\nendstream`);
  }

  write(3, `<</Type /Font /Subtype /Type1 /BaseFont /${FONT} /Encoding /WinAnsiEncoding>>`);
  write(2, `<</Type /Pages /Count ${pageCount} /Kids [${pageKids.join(" ")}]>>`);
  write(1, `<</Type /Catalog /Pages 2 0 R>>`);

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const chunks: Buffer[] = [Buffer.from(header, "latin1")];
  const xref: number[] = [0];

  for (const number of Array.from({ length: 3 + pageCount * 2 }, (_, i) => i + 1)) {
    xref.push(chunks.reduce((sum, b) => sum + b.length, 0));
    const body = objects.get(number);
    if (!body) throw new Error(`missing pdf object ${number}`);
    chunks.push(body);
  }

  const xrefStart = chunks.reduce((sum, b) => sum + b.length, 0);
  const trailer = `xref\n0 ${xref.length}\n0000000000 65535 f \n${xref
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.concat([...chunks, Buffer.from(trailer, "latin1")]);
}