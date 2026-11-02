/**
 * Minimal IMAP client for the PEC mailbox: LOGIN, SELECT/EXAMINE, UID SEARCH, UID FETCH,
 * GETQUOTAROOT, LOGOUT. It talks to anything that looks like a socket (`ImapSocket`), so tests
 * use a fake and the Worker uses `cloudflare:sockets` (see `socket.ts`). Read-only by design:
 * it never stores flags, never expunges and never deletes (messages are fetched with PEEK).
 *
 * Credentials are never part of an error message or a log line.
 */

export interface ImapSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

export class ImapError extends Error {
  constructor(
    readonly code: "protocol" | "login_failed" | "no" | "bad" | "too_large" | "closed" | "input",
    message: string,
  ) {
    super(message);
    this.name = "ImapError";
  }
}

/** Biggest literal (message part) the client accepts; bigger ones abort with `too_large`. */
export const DEFAULT_MAX_LITERAL_BYTES = 4 * 1024 * 1024;

export type ImapValue = string | Uint8Array | null | ImapValue[];

interface RawResponse {
  /** The response text with every literal replaced by `\0<index>\0`. */
  text: string;
  literals: Uint8Array[];
}

export interface MailboxInfo {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface FetchedMessage {
  seq: number;
  uid: number;
  size: number | null;
  flags: string[];
  internalDate: string | null;
  /** Raw bytes of each fetched section, keyed by the upper-cased section name, e.g. `BODY[]`. */
  sections: Record<string, Uint8Array>;
}

export interface Quota {
  /** STORAGE resource in KiB (1024 octets), as IMAP QUOTA reports it. */
  usedKb: number;
  limitKb: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ByteReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new ImapError("closed", "The server closed the connection.");
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
  }

  /** One line without its CRLF. */
  async readLine(): Promise<string> {
    let from = 0;
    for (;;) {
      for (let i = from; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = decoder.decode(this.buffer.subarray(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return line;
        }
      }
      from = Math.max(0, this.buffer.length - 1);
      await this.fill();
    }
  }

  async readBytes(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) await this.fill();
    const out = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return out;
  }

  release(): void {
    this.reader.cancel().catch(() => undefined);
  }
}

// --- Response value parser (lists, quoted strings, atoms, literals) ----------------------------

type Token =
  | { t: "open" }
  | { t: "close" }
  | { t: "value"; v: string | Uint8Array | null; atom: boolean };

function tokenize(text: string, literals: Uint8Array[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === " ") {
      i++;
    } else if (ch === "(") {
      tokens.push({ t: "open" });
      i++;
    } else if (ch === ")") {
      tokens.push({ t: "close" });
      i++;
    } else if (ch === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        value += text[i] ?? "";
        i++;
      }
      i++;
      tokens.push({ t: "value", v: value, atom: false });
    } else if (ch === "\0") {
      const end = text.indexOf("\0", i + 1);
      const literal = literals[Number(text.slice(i + 1, end))];
      tokens.push({ t: "value", v: literal ?? new Uint8Array(0), atom: false });
      i = end + 1;
    } else {
      let value = "";
      while (i < text.length && !' ()"'.includes(text[i] as string)) {
        if (text[i] === "[") {
          const end = text.indexOf("]", i);
          const stop = end === -1 ? text.length - 1 : end;
          // Section specifiers may hold spaces and parentheses, e.g. BODY[HEADER.FIELDS (A B)].
          value += text.slice(i, stop + 1);
          i = stop + 1;
        } else {
          value += text[i];
          i++;
        }
      }
      tokens.push({ t: "value", v: value.toUpperCase() === "NIL" ? null : value, atom: true });
    }
  }
  return tokens;
}

/** Parses the first value of `text` (from `start`); returns it and the number of tokens used. */
export function parseValues(text: string, literals: Uint8Array[]): ImapValue[] {
  const tokens = tokenize(text, literals);
  let pos = 0;
  const parseOne = (): ImapValue => {
    const token = tokens[pos++] as Token | undefined;
    if (!token) return null;
    if (token.t === "value") return token.v;
    if (token.t === "close") return null;
    const list: ImapValue[] = [];
    while (pos < tokens.length && (tokens[pos] as Token).t !== "close") list.push(parseOne());
    pos++;
    return list;
  };
  const values: ImapValue[] = [];
  while (pos < tokens.length) values.push(parseOne());
  return values;
}

function asText(value: ImapValue | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return decoder.decode(value);
  return "";
}

function parseFetch(response: RawResponse): FetchedMessage | null {
  const match = /^\* (\d+) FETCH (.*)$/s.exec(response.text);
  if (!match) return null;
  const [list] = parseValues(match[2] as string, response.literals);
  if (!Array.isArray(list)) return null;
  const message: FetchedMessage = {
    seq: Number(match[1]),
    uid: 0,
    size: null,
    flags: [],
    internalDate: null,
    sections: {},
  };
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = asText(list[i]).toUpperCase();
    const value = list[i + 1] as ImapValue;
    if (key === "UID") message.uid = Number(asText(value));
    else if (key === "RFC822.SIZE") message.size = Number(asText(value));
    else if (key === "INTERNALDATE") message.internalDate = asText(value);
    else if (key === "FLAGS" && Array.isArray(value)) message.flags = value.map(asText);
    else if (key.startsWith("BODY[") || key === "RFC822") {
      message.sections[key.replace(/<\d+>$/, "")] =
        value instanceof Uint8Array ? value : encoder.encode(asText(value));
    }
  }
  return message;
}

/** Quoted string for LOGIN; refuses what cannot be sent without a literal. */
export function quote(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new ImapError("input", "Credentials must be printable ASCII.");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function formatUidSet(uids: readonly number[]): string {
  if (uids.length === 0) throw new ImapError("input", "Empty UID set.");
  if (!uids.every((uid) => Number.isInteger(uid) && uid > 0)) {
    throw new ImapError("input", "Invalid UID.");
  }
  return uids.join(",");
}

export interface ImapOptions {
  maxLiteralBytes?: number;
}

export class ImapClient {
  private readonly reader: ByteReader;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private tagCounter = 0;
  private readonly maxLiteral: number;

  constructor(
    private readonly socket: ImapSocket,
    options: ImapOptions = {},
  ) {
    this.reader = new ByteReader(socket.readable);
    this.writer = socket.writable.getWriter();
    this.maxLiteral = options.maxLiteralBytes ?? DEFAULT_MAX_LITERAL_BYTES;
  }

  private async readResponse(): Promise<RawResponse> {
    let text = "";
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.reader.readLine();
      const literal = /\{(\d+)\}$/.exec(line);
      if (!literal) return { text: text + line, literals };
      const size = Number(literal[1]);
      if (size > this.maxLiteral) {
        throw new ImapError("too_large", `A message part of ${size} bytes exceeds the limit.`);
      }
      text += `${line.slice(0, literal.index)}\0${literals.length}\0`;
      literals.push(await this.reader.readBytes(size));
    }
  }

  /** Reads and checks the server greeting. */
  async greeting(): Promise<void> {
    const { text } = await this.readResponse();
    if (!/^\* (OK|PREAUTH)\b/i.test(text)) {
      throw new ImapError("protocol", "Unexpected IMAP greeting.");
    }
  }

  private async execute(
    command: string,
  ): Promise<{ status: "OK" | "NO" | "BAD"; text: string; untagged: RawResponse[] }> {
    const tag = `A${++this.tagCounter}`;
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`));
    const untagged: RawResponse[] = [];
    for (;;) {
      const response = await this.readResponse();
      if (response.text.startsWith(`${tag} `)) {
        const rest = response.text.slice(tag.length + 1);
        const status = /^(OK|NO|BAD)\b/i.exec(rest)?.[1]?.toUpperCase() as
          | "OK"
          | "NO"
          | "BAD"
          | undefined;
        if (!status) throw new ImapError("protocol", "Malformed tagged response.");
        return { status, text: rest, untagged };
      }
      if (response.text.startsWith("+")) {
        throw new ImapError("protocol", "Unexpected continuation request.");
      }
      if (/^\* BYE\b/i.test(response.text)) {
        throw new ImapError("closed", "The server ended the session.");
      }
      untagged.push(response);
    }
  }

  private async run(command: string) {
    const result = await this.execute(command);
    if (result.status !== "OK") {
      throw new ImapError(result.status === "NO" ? "no" : "bad", result.text.slice(0, 200));
    }
    return result;
  }

  async login(username: string, password: string): Promise<void> {
    const result = await this.execute(`LOGIN ${quote(username)} ${quote(password)}`);
    if (result.status !== "OK") {
      throw new ImapError("login_failed", "The mailbox rejected the username or password.");
    }
  }

  /** EXAMINE (read-only) by default; the app never changes the mailbox. */
  async select(mailbox = "INBOX", readOnly = true): Promise<MailboxInfo> {
    const { untagged } = await this.run(`${readOnly ? "EXAMINE" : "SELECT"} ${quote(mailbox)}`);
    const info: MailboxInfo = { uidValidity: 0, uidNext: 0, exists: 0 };
    for (const { text } of untagged) {
      const validity = /\[UIDVALIDITY (\d+)\]/i.exec(text);
      const next = /\[UIDNEXT (\d+)\]/i.exec(text);
      const exists = /^\* (\d+) EXISTS/i.exec(text);
      if (validity) info.uidValidity = Number(validity[1]);
      if (next) info.uidNext = Number(next[1]);
      if (exists) info.exists = Number(exists[1]);
    }
    if (info.uidValidity === 0) throw new ImapError("protocol", "The mailbox sent no UIDVALIDITY.");
    return info;
  }

  /** UIDs greater than `lastUid`, ascending. `UID n:*` always matches the last message, so filter. */
  async searchNewerThan(lastUid: number): Promise<number[]> {
    const { untagged } = await this.run(`UID SEARCH UID ${lastUid + 1}:*`);
    const uids: number[] = [];
    for (const { text } of untagged) {
      const match = /^\* SEARCH ?(.*)$/i.exec(text);
      if (match?.[1]) uids.push(...match[1].split(" ").filter(Boolean).map(Number));
    }
    return [...new Set(uids)].filter((uid) => uid > lastUid).sort((a, b) => a - b);
  }

  private async fetch(uids: readonly number[], items: string): Promise<FetchedMessage[]> {
    const { untagged } = await this.run(`UID FETCH ${formatUidSet(uids)} (${items})`);
    return untagged.map(parseFetch).filter((m): m is FetchedMessage => m !== null && m.uid > 0);
  }

  /** Size, flags, date and a few headers, without downloading the messages. */
  fetchSummaries(uids: readonly number[]): Promise<FetchedMessage[]> {
    return this.fetch(
      uids,
      "UID RFC822.SIZE FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)]",
    );
  }

  /** The whole RFC 822 source of one message (does not set \Seen). */
  async fetchSource(uid: number): Promise<Uint8Array | null> {
    const [message] = await this.fetch([uid], "UID BODY.PEEK[]");
    return message?.sections["BODY[]"] ?? null;
  }

  /** STORAGE quota of the mailbox, or null when the server has no QUOTA support. */
  async getQuota(mailbox = "INBOX"): Promise<Quota | null> {
    const result = await this.execute(`GETQUOTAROOT ${quote(mailbox)}`);
    if (result.status !== "OK") return null;
    for (const { text } of result.untagged) {
      const match = /^\* QUOTA .*\(.*\bSTORAGE (\d+) (\d+)/i.exec(text);
      if (match) return { usedKb: Number(match[1]), limitKb: Number(match[2]) };
    }
    return null;
  }

  async logout(): Promise<void> {
    try {
      await this.execute("LOGOUT");
    } catch {
      // The server may drop the connection right after BYE.
    }
    await this.close();
  }

  async close(): Promise<void> {
    this.reader.release();
    try {
      await this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Connects, greets and logs in; on any failure the socket is closed. */
export async function openMailbox(
  socket: ImapSocket,
  credentials: { username: string; password: string },
  options?: ImapOptions,
): Promise<ImapClient> {
  const client = new ImapClient(socket, options);
  try {
    await client.greeting();
    await client.login(credentials.username, credentials.password);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
