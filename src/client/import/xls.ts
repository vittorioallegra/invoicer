/**
 * A small reader for the legacy Excel format (`.xls`: BIFF8 records inside an OLE2 compound file).
 * Browser-side only, like pkijs and fflate (heavy work stays out of the Worker); no dependency.
 * It reads what an account-summary export needs: worksheets, text and numbers (shared strings,
 * LABEL, NUMBER, RK, MULRK, formula results) and the date system. Everything else is skipped.
 * A file that is not a readable workbook throws `XlsError`, never anything else.
 */

export type XlsErrorCode = "not_xls" | "no_workbook" | "truncated" | "too_large";

export class XlsError extends Error {
  code: XlsErrorCode;
  constructor(code: XlsErrorCode) {
    super(`xls: ${code}`);
    this.name = "XlsError";
    this.code = code;
  }
}

/** A cell value: text or a number (dates are serial numbers, see `date1904`). */
export type XlsCell = string | number;

export interface XlsSheet {
  name: string;
  /** `rows[row]?.[column]`, zero-based; missing rows and cells are `undefined`. */
  rows: (XlsCell | undefined)[][];
}

export interface XlsWorkbook {
  sheets: XlsSheet[];
  /** True when serial dates count from 1904 (older Mac files). */
  date1904: boolean;
}

/** Largest file read; a summary export is a few hundred KB at most. */
export const MAX_XLS_BYTES = 10 * 1024 * 1024;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN_MIN = 0xfffffffa;

const fail = (code: XlsErrorCode): never => {
  throw new XlsError(code);
};

// ---- OLE2 compound file ----

/** The bytes of the workbook stream ("Workbook", or "Book" in BIFF5 files). */
function workbookStream(data: Uint8Array): Uint8Array {
  if (data.length < 512 || SIGNATURE.some((byte, i) => data[i] !== byte)) fail("not_xls");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sectorShift = view.getUint16(30, true);
  const miniShift = view.getUint16(32, true);
  if (sectorShift !== 9 && sectorShift !== 12) fail("not_xls");
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const fatCount = view.getUint32(44, true);
  const dirStart = view.getUint32(48, true);
  const cutoff = view.getUint32(56, true);
  const miniFatStart = view.getUint32(60, true);
  const difatStart = view.getUint32(68, true);
  const difatCount = view.getUint32(72, true);

  const sectorOffset = (index: number) => (index + 1) * sectorSize;
  const sector = (index: number): Uint8Array => {
    const start = sectorOffset(index);
    if (start >= data.length) return fail("truncated");
    return data.subarray(start, Math.min(start + sectorSize, data.length));
  };
  const u32s = (bytes: Uint8Array): number[] => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[] = [];
    for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(dv.getUint32(i, true));
    return out;
  };

  // The sectors holding the FAT: 109 in the header, the rest chained through DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) fatSectors.push(view.getUint32(76 + i * 4, true));
  let difat = difatStart;
  for (let n = 0; n < difatCount && difat < END_OF_CHAIN_MIN; n++) {
    const values = u32s(sector(difat));
    fatSectors.push(...values.slice(0, -1));
    difat = values[values.length - 1] ?? END_OF_CHAIN_MIN;
  }
  const fat: number[] = [];
  for (const index of fatSectors.filter((s) => s < END_OF_CHAIN_MIN).slice(0, fatCount)) {
    fat.push(...u32s(sector(index)));
  }

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let index = start;
    while (index < END_OF_CHAIN_MIN) {
      if (out.length > table.length) return fail("truncated");
      out.push(index);
      const next = table[index];
      if (next === undefined) return fail("truncated");
      index = next;
    }
    return out;
  };
  const join = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const readChain = (start: number): Uint8Array => join(chain(start, fat).map(sector));

  const directory = readChain(dirStart);
  const dv = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let at = 0; at + 128 <= directory.length; at += 128) {
    const nameLength = Math.max(0, Math.min(dv.getUint16(at + 64, true), 64) - 2);
    let name = "";
    for (let i = 0; i < nameLength; i += 2) name += String.fromCharCode(dv.getUint16(at + i, true));
    entries.push({
      name,
      type: directory[at + 66] ?? 0,
      start: dv.getUint32(at + 116, true),
      size: dv.getUint32(at + 120, true),
    });
  }
  const root = entries.find((entry) => entry.type === 5);
  const target = entries.find(
    (entry) => entry.type === 2 && (entry.name === "Workbook" || entry.name === "Book"),
  );
  if (!root || !target) return fail("no_workbook");
  if (target.size > data.length) return fail("truncated");

  if (target.size >= cutoff) return readChain(target.start).subarray(0, target.size);

  // A small stream lives in the mini stream, cut into 64-byte mini sectors.
  const miniStream = readChain(root.start);
  const miniFat = chain(miniFatStart, fat).flatMap((index) => u32s(sector(index)));
  const parts: Uint8Array[] = [];
  for (const index of chain(target.start, miniFat)) {
    const at = index * miniSize;
    if (at + miniSize > miniStream.length) return fail("truncated");
    parts.push(miniStream.subarray(at, at + miniSize));
  }
  return join(parts).subarray(0, target.size);
}

// ---- BIFF8 records ----

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  DATEMODE: 0x0022,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
} as const;

interface Rec {
  id: number;
  body: Uint8Array;
}

function* records(book: Uint8Array, from = 0): Generator<Rec & { at: number }> {
  const dv = new DataView(book.buffer, book.byteOffset, book.byteLength);
  let at = from;
  while (at + 4 <= book.length) {
    const id = dv.getUint16(at, true);
    const length = dv.getUint16(at + 2, true);
    if (at + 4 + length > book.length) return fail("truncated");
    yield { id, body: book.subarray(at + 4, at + 4 + length), at };
    at += 4 + length;
  }
}

/** Number stored in an RK field: a 30-bit integer or the top 30 bits of a double, maybe /100. */
function rkValue(raw: number): number {
  let value: number;
  if (raw & 2) {
    value = (raw | 0) >> 2;
  } else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, (raw & 0xfffffffc) >>> 0, true);
    value = buffer.getFloat64(0, true);
  }
  return raw & 1 ? value / 100 : value;
}

const decode = (bytes: Uint8Array, wide: boolean): string => {
  let out = "";
  if (wide) {
    for (let i = 0; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
  } else {
    for (const byte of bytes) out += String.fromCharCode(byte);
  }
  return out;
};

/** The shared string table: the SST record and its CONTINUE records, in order. */
function readSst(chunks: Uint8Array[]): string[] {
  const first = chunks[0];
  if (!first || first.length < 8) return [];
  const unique = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(4, true);
  const strings: string[] = [];
  let chunk = 0;
  let cur = first;
  let pos = 8;
  const dv = () => new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
  const nextChunk = () => {
    chunk += 1;
    const next = chunks[chunk];
    if (!next) return fail("truncated");
    cur = next;
    pos = 0;
  };

  while (strings.length < unique) {
    if (pos >= cur.length) {
      if (chunk + 1 >= chunks.length) break;
      nextChunk();
    }
    if (pos + 3 > cur.length) return fail("truncated");
    const length = dv().getUint16(pos, true);
    const flags = cur[pos + 2] ?? 0;
    pos += 3;
    let runs = 0;
    let extra = 0;
    if (flags & 8) {
      runs = dv().getUint16(pos, true);
      pos += 2;
    }
    if (flags & 4) {
      extra = dv().getUint32(pos, true);
      pos += 4;
    }
    let wide = (flags & 1) === 1;
    let text = "";
    let remaining = length;
    while (remaining > 0) {
      if (pos >= cur.length) {
        nextChunk();
        // A string continued in the next record starts it with its own flags byte.
        wide = ((cur[0] ?? 0) & 1) === 1;
        pos = 1;
      }
      const width = wide ? 2 : 1;
      const take = Math.min(Math.floor((cur.length - pos) / width), remaining);
      if (take <= 0) return fail("truncated");
      text += decode(cur.subarray(pos, pos + take * width), wide);
      pos += take * width;
      remaining -= take;
    }
    let skip = runs * 4 + extra;
    while (skip > 0) {
      if (pos >= cur.length) nextChunk();
      const step = Math.min(skip, cur.length - pos);
      pos += step;
      skip -= step;
    }
    strings.push(text);
  }
  return strings;
}

function readSheet(book: Uint8Array, offset: number, sst: string[]): (XlsCell | undefined)[][] {
  const rows: (XlsCell | undefined)[][] = [];
  const put = (row: number, col: number, value: XlsCell) => {
    const line = rows[row] ?? [];
    line[col] = value;
    rows[row] = line;
  };
  let depth = 0;
  let formula: [number, number] | null = null;
  for (const { id, body } of records(book, offset)) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (id === REC.BOF) {
      depth += 1;
    } else if (id === REC.EOF) {
      depth -= 1;
      if (depth <= 0) break;
    } else if (depth === 1) {
      if (id === REC.LABELSST) {
        const text = sst[dv.getUint32(6, true)];
        if (text !== undefined) put(dv.getUint16(0, true), dv.getUint16(2, true), text);
      } else if (id === REC.NUMBER) {
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getFloat64(6, true));
      } else if (id === REC.RK) {
        put(dv.getUint16(0, true), dv.getUint16(2, true), rkValue(dv.getUint32(6, true)));
      } else if (id === REC.MULRK) {
        const row = dv.getUint16(0, true);
        const first = dv.getUint16(2, true);
        const last = dv.getUint16(body.length - 2, true);
        for (let col = first; col <= last; col++) {
          put(row, col, rkValue(dv.getUint32(4 + (col - first) * 6 + 2, true)));
        }
      } else if (id === REC.LABEL) {
        const length = dv.getUint16(6, true);
        const wide = ((body[8] ?? 0) & 1) === 1;
        put(
          dv.getUint16(0, true),
          dv.getUint16(2, true),
          decode(body.subarray(9, 9 + length * (wide ? 2 : 1)), wide),
        );
      } else if (id === REC.FORMULA) {
        const row = dv.getUint16(0, true);
        const col = dv.getUint16(2, true);
        if (dv.getUint16(12, true) === 0xffff) {
          // A text result follows in a STRING record; booleans, errors and empty are skipped.
          if (body[6] === 0) formula = [row, col];
        } else {
          put(row, col, dv.getFloat64(6, true));
        }
      } else if (id === REC.STRING && formula) {
        const length = dv.getUint16(0, true);
        const wide = ((body[2] ?? 0) & 1) === 1;
        put(formula[0], formula[1], decode(body.subarray(3, 3 + length * (wide ? 2 : 1)), wide));
        formula = null;
      }
    }
  }
  return rows;
}

/** Reads every worksheet of an `.xls` file. Throws `XlsError` when it cannot. */
export function readXls(data: Uint8Array): XlsWorkbook {
  if (data.length > MAX_XLS_BYTES) throw new XlsError("too_large");
  try {
    const book = workbookStream(data);
    const sstChunks: Uint8Array[] = [];
    const boundSheets: { name: string; offset: number; worksheet: boolean }[] = [];
    let date1904 = false;
    let started = false;
    let inSst = false;
    for (const { id, body } of records(book)) {
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      if (id === REC.BOF) {
        if (started) break;
        started = true;
        // The workbook globals start the stream; anything else is not a BIFF8 workbook.
        if (dv.getUint16(0, true) !== 0x0600) fail("not_xls");
      } else if (!started) {
        fail("not_xls");
      } else if (id === REC.EOF) {
        break;
      } else if (id === REC.DATEMODE) {
        date1904 = dv.getUint16(0, true) === 1;
      } else if (id === REC.BOUNDSHEET) {
        const length = body[6] ?? 0;
        const wide = ((body[7] ?? 0) & 1) === 1;
        boundSheets.push({
          name: decode(body.subarray(8, 8 + length * (wide ? 2 : 1)), wide),
          offset: dv.getUint32(0, true),
          worksheet: (body[5] ?? 0) === 0,
        });
      } else if (id === REC.SST) {
        sstChunks.push(body);
        inSst = true;
      } else if (id === REC.CONTINUE && inSst) {
        sstChunks.push(body);
      } else {
        inSst = false;
      }
    }
    if (!started) fail("not_xls");
    const sst = readSst(sstChunks);
    const sheets = boundSheets
      .filter((sheet) => sheet.worksheet)
      .map((sheet) => ({ name: sheet.name, rows: readSheet(book, sheet.offset, sst) }));
    return { sheets, date1904 };
  } catch (error) {
    if (error instanceof XlsError) throw error;
    throw new XlsError("truncated");
  }
}

/** A serial date (days since 1899-12-30, or 1904-01-01) as `YYYY-MM-DD`; null when not a date. */
export function serialToIsoDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const days = Math.floor(serial);
  // 1900 date system: day 60 is the nonexistent 1900-02-29, so the epoch is 1899-12-30 after it.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + days * 86_400_000);
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 9999) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
