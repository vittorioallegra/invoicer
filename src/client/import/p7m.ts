import { fromBER, type OctetString } from "asn1js";
import { ContentInfo, SignedData } from "pkijs";

/**
 * Reads the signed content out of a CAdES `.p7m` file (the XML an Italian invoice signature
 * wraps). The signature itself is not verified: the file arrived through the SdI, and the owner
 * only needs the invoice inside. Runs in the browser (pkijs/asn1js are client-only libraries).
 */

export class P7mError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "P7mError";
  }
}

/** Largest nesting of signatures unwrapped (a signed P7M is sometimes signed again). */
const MAX_LAYERS = 4;

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A `.p7m` may be stored as DER/BER or as base64 text (with or without PEM lines). */
function binaryForm(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0x30) return bytes;
  const text = new TextDecoder("latin1")
    .decode(bytes)
    .replace(/-----[A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  if (text === "" || !/^[A-Za-z0-9+/]+=*$/.test(text)) throw new P7mError("not_p7m");
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    throw new P7mError("not_p7m");
  }
}

/** The bytes of an OCTET STRING, joining the chunks of a constructed (BER) one. */
function octets(value: OctetString): Uint8Array {
  const chunks: Uint8Array[] = [];
  const walk = (node: OctetString) => {
    if (node.valueBlock.isConstructed) {
      for (const child of node.valueBlock.value as OctetString[]) walk(child);
    } else {
      chunks.push(new Uint8Array(node.valueBlock.valueHexView));
    }
  };
  walk(value);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function unwrapOnce(bytes: Uint8Array): Uint8Array {
  const parsed = fromBER(asArrayBuffer(binaryForm(bytes)));
  if (parsed.offset === -1) throw new P7mError("not_p7m");
  try {
    const info = new ContentInfo({ schema: parsed.result });
    const signed = new SignedData({ schema: info.content });
    const content = signed.encapContentInfo.eContent;
    if (!content) throw new P7mError("no_content");
    return octets(content);
  } catch (error) {
    if (error instanceof P7mError) throw error;
    throw new P7mError("not_p7m");
  }
}

/** True for a `.p7m` file name (the signature may also come with other names, e.g. `.xml.p7m`). */
export const isP7mName = (name: string): boolean => /\.p7m$/i.test(name);

/** The signed document inside a `.p7m` file, unwrapping nested signatures. */
export function extractP7m(bytes: Uint8Array): Uint8Array {
  let current = bytes;
  for (let layer = 0; layer < MAX_LAYERS; layer++) {
    current = unwrapOnce(current);
    // Another signature (a DER sequence) wraps the document once more; anything else is the document.
    if (current[0] !== 0x30) return current;
  }
  return current;
}
