import { connect } from "cloudflare:sockets";
import type { ImapSocket } from "./imap";

export const DEFAULT_IMAP_HOST = "imaps.pec.aruba.it";
export const DEFAULT_IMAP_PORT = 993;

/** Implicit-TLS connection to the PEC IMAP server (the only runtime import of the sockets API). */
export function connectImap(host = DEFAULT_IMAP_HOST, port = DEFAULT_IMAP_PORT): ImapSocket {
  return connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
}
