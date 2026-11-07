/**
 * Test helper: writes a small legacy `.xls` (OLE2 container with a BIFF8 workbook) from plain
 * rows, so the reader and the summary parser are tested end to end with invented data. It writes
 * what a real export holds: a shared string table that can spill into CONTINUE records (a string
 * crossing the boundary re-sends its flags byte), LABELSST, NUMBER, RK and MULRK cells.
 */

export type FixtureCell =
  | string
  | number
  | null
  /** Written as an RK record (an integer, or a value with at most two decimals). */
  | { rk: number }
  /** Written as one MULRK record over this and the next columns (leave those cells null). */
  | { mulrk: number[] }
  /** Written as a LABEL record (an inline string, not shared). */
  | { label: string }
  /** A rich-text shared string with this many formatting runs. */
  | { rich: string; runs: number };

export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
}

export interface FixtureOptions {
  date1904?: boolean;
  /** Payload size at which the string table is cut into CONTINUE records (default 8224). */
  chunkLimit?: number;
  /** Keep the workbook stream in the mini stream (only when it is under 4096 bytes). */
  mini?: boolean;
  /** Pad the workbook stream to at least this many bytes (default 4096, the regular sectors). */
  minBytes?: number;
}

class Bytes {
  parts: number[] = [];
  u8(value: number) {
    this.parts.push(value & 0xff);
    return this;
  }
  u16(value: number) {
    return this.u8(value).u8(value >> 8);
  }
  u32(value: number) {
    return this.u16(value & 0xffff).u16(value >>> 16);
  }
  f64(value: number) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
    return this;
  }
  raw(bytes: ArrayLike<number>) {
    for (let i = 0; i < bytes.length; i++) this.u8(bytes[i] ?? 0);
    return this;
  }
  get length() {
    return this.parts.length;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

const record = (id: number, body: Uint8Array | Bytes): Uint8Array => {
  const bytes = body instanceof Bytes ? body.done() : body;
  return new Bytes().u16(id).u16(bytes.length).raw(bytes).done();
};

const isLatin1 = (text: string) => [...text].every((char) => char.charCodeAt(0) < 256);

const encodeText = (text: string, wide: boolean): number[] => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out.push(code & 0xff);
    if (wide) out.push(code >> 8);
  }
  return out;
};

interface SstString {
  text: string;
  runs: number;
}

/** The SST record and its CONTINUE records. */
function sstRecords(strings: SstString[], total: number, limit: number): Uint8Array[] {
  const chunks: number[][] = [[]];
  const head = new Bytes().u32(total).u32(strings.length).done();
  chunks[0] = [...head];
  const flush = () => chunks.push([]);
  for (const { text, runs } of strings) {
    const wide = !isLatin1(text);
    const header = new Bytes().u16(text.length).u8((wide ? 1 : 0) | (runs > 0 ? 8 : 0));
    if (runs > 0) header.u16(runs);
    const current = () => chunks[chunks.length - 1] as number[];
    if (current().length + header.length > limit) flush();
    current().push(...header.done());
    const width = wide ? 2 : 1;
    for (let i = 0; i < text.length; i++) {
      if (current().length + width > limit) {
        flush();
        // The continued string starts again with its flags byte.
        current().push(wide ? 1 : 0);
      }
      current().push(...encodeText(text[i] as string, wide));
    }
    if (runs > 0) {
      for (let r = 0; r < runs * 4; r++) {
        if (current().length + 1 > limit) flush();
        current().push(0);
      }
    }
  }
  return chunks.map((chunk, index) =>
    record(index === 0 ? 0x00fc : 0x003c, Uint8Array.from(chunk)),
  );
}

function rkEncode(value: number): number {
  if (Number.isInteger(value) && Math.abs(value) < 2 ** 29) return ((value << 2) | 2) >>> 0;
  const scaled = Math.round(value * 100);
  if (Math.abs(scaled) < 2 ** 29) return ((scaled << 2) | 3) >>> 0;
  throw new Error("value does not fit an RK field");
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** The BIFF8 workbook stream. */
function workbook(sheets: FixtureSheet[], options: FixtureOptions): Uint8Array {
  // Shared strings in first-use order.
  const shared = new Map<string, number>();
  const list: SstString[] = [];
  let total = 0;
  const intern = (text: string, runs: number) => {
    total += 1;
    const key = `${runs}:${text}`;
    let index = shared.get(key);
    if (index === undefined) {
      index = list.length;
      list.push({ text, runs });
      shared.set(key, index);
    }
    return index;
  };
  const bodies = sheets.map((sheet) => {
    const out: Uint8Array[] = [
      record(0x0809, new Bytes().u16(0x0600).u16(0x0010).u16(0x0dbb).u16(0x07cc).u32(0).u32(6)),
    ];
    sheet.rows.forEach((cells, row) => {
      cells.forEach((cell, col) => {
        const head = () => new Bytes().u16(row).u16(col).u16(0x000f);
        if (cell === null) return;
        if (typeof cell === "string") {
          out.push(record(0x00fd, head().u32(intern(cell, 0))));
        } else if (typeof cell === "number") {
          out.push(record(0x0203, head().f64(cell)));
        } else if ("rk" in cell) {
          out.push(record(0x027e, head().u32(rkEncode(cell.rk))));
        } else if ("mulrk" in cell) {
          const body = new Bytes().u16(row).u16(col);
          for (const value of cell.mulrk) body.u16(0x000f).u32(rkEncode(value));
          out.push(record(0x00bd, body.u16(col + cell.mulrk.length - 1)));
        } else if ("label" in cell) {
          const wide = !isLatin1(cell.label);
          out.push(
            record(
              0x0204,
              head()
                .u16(cell.label.length)
                .u8(wide ? 1 : 0)
                .raw(encodeText(cell.label, wide)),
            ),
          );
        } else {
          out.push(record(0x00fd, head().u32(intern(cell.rich, cell.runs))));
        }
      });
    });
    out.push(record(0x000a, new Bytes()));
    return concat(out);
  });

  const globalsWithoutSheets = (offsets: number[]): Uint8Array => {
    const out: Uint8Array[] = [
      record(0x0809, new Bytes().u16(0x0600).u16(0x0005).u16(0x0dbb).u16(0x07cc).u32(0).u32(6)),
      record(0x0022, new Bytes().u16(options.date1904 ? 1 : 0)),
    ];
    sheets.forEach((sheet, index) => {
      const wide = !isLatin1(sheet.name);
      out.push(
        record(
          0x0085,
          new Bytes()
            .u32(offsets[index] ?? 0)
            .u8(0)
            .u8(0)
            .u8(sheet.name.length)
            .u8(wide ? 1 : 0)
            .raw(encodeText(sheet.name, wide)),
        ),
      );
    });
    out.push(...sstRecords(list, total, options.chunkLimit ?? 8224));
    // An unknown record standing in for the other globals, also used to reach the stream size.
    const used = concat(out).length + 4 + 4;
    const pad = Math.max(0, (options.minBytes ?? (options.mini ? 0 : 4096)) - used - bodiesLength);
    if (pad > 0) out.push(record(0x1fff, new Uint8Array(Math.min(pad, 8000))));
    out.push(record(0x000a, new Bytes()));
    return concat(out);
  };
  const bodiesLength = bodies.reduce((sum, body) => sum + body.length, 0);
  // Two passes: the globals length does not depend on the offsets.
  const length = globalsWithoutSheets(sheets.map(() => 0)).length;
  const offsets: number[] = [];
  let at = length;
  for (const body of bodies) {
    offsets.push(at);
    at += body.length;
  }
  return concat([globalsWithoutSheets(offsets), ...bodies]);
}

const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const FREE = 0xffffffff;

function directoryEntry(
  name: string,
  type: number,
  start: number,
  size: number,
  child: number,
): Uint8Array {
  const bytes = new Bytes();
  const nameBytes = encodeText(name, true);
  bytes.raw(nameBytes);
  while (bytes.length < 64) bytes.u8(0);
  bytes
    .u16(name ? nameBytes.length + 2 : 0)
    .u8(type)
    .u8(1)
    .u32(FREE)
    .u32(FREE)
    .u32(child);
  while (bytes.length < 116) bytes.u8(0);
  return bytes.u32(start).u32(size).u32(0).done();
}

/** Wraps a workbook stream into an OLE2 compound file (512-byte sectors). */
function ole(stream: Uint8Array, mini: boolean): Uint8Array {
  const SECTOR = 512;
  const sectorsOf = (bytes: Uint8Array) => Math.ceil(bytes.length / SECTOR);
  const pad = (bytes: Uint8Array, unit: number) => {
    const out = new Uint8Array(Math.ceil(bytes.length / unit) * unit);
    out.set(bytes);
    return out;
  };

  // Sectors after the FAT, in order: directory, then the stream (or mini FAT + mini stream).
  const body: Uint8Array[] = [];
  const next: number[] = []; // FAT entries of the sectors after the FAT, relative to `base`
  const addChain = (data: Uint8Array): number => {
    const count = sectorsOf(data);
    const first = next.length;
    for (let i = 0; i < count; i++) next.push(i === count - 1 ? ENDOFCHAIN : first + i + 1);
    body.push(pad(data, SECTOR));
    return first;
  };

  const placeholder = { dir: 0, stream: 0, mini: 0, miniFat: 0 };
  let miniStreamSize = 0;
  let dataBytes: Uint8Array = stream;
  if (mini) {
    const miniSectors = Math.ceil(stream.length / 64);
    const miniFat = new Bytes();
    for (let i = 0; i < miniSectors; i++) miniFat.u32(i === miniSectors - 1 ? ENDOFCHAIN : i + 1);
    while (miniFat.length % SECTOR !== 0) miniFat.u32(FREE);
    miniStreamSize = miniSectors * 64;
    dataBytes = pad(stream, 64);
    placeholder.dir = addChain(new Uint8Array(SECTOR));
    placeholder.miniFat = addChain(miniFat.done());
    placeholder.mini = addChain(dataBytes);
  } else {
    placeholder.dir = addChain(new Uint8Array(SECTOR));
    placeholder.stream = addChain(stream);
  }

  let fatCount = 1;
  while (fatCount * 128 < next.length + fatCount) fatCount += 1;
  const shift = (value: number) => (value === ENDOFCHAIN ? value : value + fatCount);
  const fat: number[] = [];
  for (let i = 0; i < fatCount; i++) fat.push(FATSECT);
  for (const value of next) fat.push(shift(value));
  while (fat.length % 128 !== 0) fat.push(FREE);

  const directory = concat([
    directoryEntry(
      "Root Entry",
      5,
      mini ? shift(placeholder.mini) : ENDOFCHAIN,
      mini ? miniStreamSize : 0,
      1,
    ),
    directoryEntry("Workbook", 2, mini ? 0 : shift(placeholder.stream), stream.length, FREE),
    directoryEntry("", 0, 0, 0, FREE),
    directoryEntry("", 0, 0, 0, FREE),
  ]);
  body[0] = directory;

  const header = new Bytes()
    .raw([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    .raw(new Array(16).fill(0))
    .u16(0x003e)
    .u16(3)
    .u16(0xfffe)
    .u16(9)
    .u16(6)
    .raw(new Array(6).fill(0))
    .u32(0)
    .u32(fatCount)
    .u32(shift(placeholder.dir))
    .u32(0)
    .u32(4096)
    .u32(mini ? shift(placeholder.miniFat) : ENDOFCHAIN)
    .u32(mini ? 1 : 0)
    .u32(ENDOFCHAIN)
    .u32(0);
  for (let i = 0; i < 109; i++) header.u32(i < fatCount ? i : FREE);
  while (header.length < SECTOR) header.u8(0);

  const fatBytes = new Bytes();
  for (const value of fat) fatBytes.u32(value);
  return concat([header.done(), fatBytes.done(), ...body]);
}

/** A complete `.xls` file holding these sheets. */
export function buildXls(sheets: FixtureSheet[], options: FixtureOptions = {}): Uint8Array {
  return ole(workbook(sheets, options), options.mini === true);
}
