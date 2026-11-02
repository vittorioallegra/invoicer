import PostalMime from "postal-mime";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Uint8Array;
}

export interface ParsedMessage {
  messageId: string | null;
  from: string | null;
  subject: string | null;
  /** ISO date of the `Date` header, when it parses. */
  date: string | null;
  /** First value of each header, keyed by the lower-cased name. */
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
}

export interface ParsedPecEnvelope extends ParsedMessage {
  /** Raw `daticert.xml` text, when present. */
  daticert: string | null;
  /** The original message carried by `postacert.eml` (an SdI notification, an invoice...). */
  inner: ParsedMessage | null;
}

const decoder = new TextDecoder();

function firstHeaders(list: { key: string; value: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of list ?? []) {
    const name = key.toLowerCase();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

async function parseMessage(source: string | Uint8Array): Promise<ParsedMessage> {
  const email = await PostalMime.parse(source, { forceRfc822Attachments: true });
  return {
    messageId: email.messageId ?? null,
    from: email.from?.address ?? null,
    subject: email.subject ?? null,
    date: email.date ?? null,
    headers: firstHeaders(email.headers),
    attachments: email.attachments.map((a) => {
      const content =
        typeof a.content === "string"
          ? new TextEncoder().encode(a.content)
          : new Uint8Array(a.content);
      return {
        filename: a.filename ?? "",
        mimeType: a.mimeType,
        size: content.byteLength,
        content,
      };
    }),
  };
}

/**
 * Parses a PEC transport envelope: the outer message, `daticert.xml` and the original message
 * in `postacert.eml`. `classify.ts` builds on this.
 */
export async function parsePecEnvelope(source: string | Uint8Array): Promise<ParsedPecEnvelope> {
  const outer = await parseMessage(source);
  const find = (name: string) => outer.attachments.find((a) => a.filename.toLowerCase() === name);
  const daticert = find("daticert.xml");
  const postacert = find("postacert.eml");
  return {
    ...outer,
    daticert: daticert ? decoder.decode(daticert.content) : null,
    inner: postacert ? await parseMessage(postacert.content) : null,
  };
}
