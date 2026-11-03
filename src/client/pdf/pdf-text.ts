import { inflateSync } from "node:zlib";

/**
 * Minimal text extraction, enough for the standard Helvetica fonts the PDF uses: inflate every
 * stream and decode the hex strings of the text-showing operators (WinAnsi, one byte per glyph).
 */
export function extractText(pdf: Uint8Array): string {
  return extractPages(pdf).join("\n");
}

/** The text of each page content stream, in page order. */
export function extractPages(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf).toString("latin1");
  const pages: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1] ?? "", "latin1")).toString("latin1");
    } catch {
      continue;
    }
    const parts: string[] = [];
    for (const op of content.matchAll(
      /\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g,
    )) {
      const hexes = [...(op[1] ?? op[2] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map(
        (m) => m[1] ?? "",
      );
      if (op[2] !== undefined) hexes.push(op[2]);
      parts.push(
        hexes
          .map((h) => Buffer.from(h, "hex").toString("latin1").replaceAll("\u0080", "€"))
          .join(""),
      );
    }
    if (parts.length > 0) pages.push(parts.join("\n").replaceAll(" ", " "));
  }
  return pages;
}
