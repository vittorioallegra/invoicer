import { type FakeSocket, fakeServer, literal } from "./fake-socket";

/**
 * A stateful fake IMAP server over a list of messages: LOGIN, EXAMINE, UID SEARCH, UID FETCH
 * (summaries and `BODY.PEEK[]`) and LOGOUT. Anything else, including every command that would
 * change the mailbox, is answered `BAD` and stays visible in `received`, so tests can assert the
 * poller is read-only. Test support only: never imported by Worker code.
 */
export interface FakeMessage {
  uid: number;
  source: string;
}

export interface FakeMailbox {
  uidValidity: number;
  messages: FakeMessage[];
  /** `false` answers LOGIN with NO (wrong password). */
  loginOk?: boolean;
}

const encoder = new TextEncoder();
export const FAKE_GREETING = "* OK [CAPABILITY IMAP4rev1 QUOTA] Fake IMAP ready.\r\n";

function uidSet(set: string): number[] {
  return set.split(",").flatMap((part) => {
    const [from, to] = part.split(":").map(Number);
    return to === undefined ? [from as number] : [from as number, to];
  });
}

function headersOf(source: string): string {
  const wanted = ["message-id", "from", "subject", "date"];
  const head = source.split(/\r\n\r\n/)[0] ?? "";
  const lines = head
    .split("\r\n")
    .filter((line) => wanted.includes(line.split(":")[0]?.toLowerCase() ?? ""));
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function fakeMailbox(
  mailbox: FakeMailbox,
  options: { chunkSize?: number } = {},
): FakeSocket {
  const sorted = () => [...mailbox.messages].sort((a, b) => a.uid - b.uid);
  return fakeServer(
    FAKE_GREETING,
    (line) => {
      const [tag = "", command = "", ...rest] = line.split(" ");
      const args = rest.join(" ");
      const ok = (text = "completed") => `${tag} OK ${text}\r\n`;
      if (command === "LOGIN") {
        return mailbox.loginOk === false
          ? `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`
          : ok("Logged in");
      }
      if (command === "EXAMINE") {
        const next = Math.max(0, ...mailbox.messages.map((m) => m.uid)) + 1;
        return (
          `* ${mailbox.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid\r\n` +
          `* OK [UIDNEXT ${next}] Predicted next UID\r\n${tag} OK [READ-ONLY] Examine completed\r\n`
        );
      }
      if (command === "UID" && args.startsWith("SEARCH UID ")) {
        const from = Number(/UID (\d+):\*/.exec(args)?.[1]);
        const all = sorted();
        let found = all.filter((m) => m.uid >= from).map((m) => m.uid);
        // `n:*` always matches the last message, even when it is older than `n`.
        if (found.length === 0 && all.length > 0) found = [(all.at(-1) as FakeMessage).uid];
        return `* SEARCH ${found.join(" ")}\r\n${ok("Search completed")}`;
      }
      if (command === "UID" && args.startsWith("FETCH ")) {
        const match = /^FETCH (\S+) \((.*)\)$/.exec(args);
        const uids = new Set(uidSet(match?.[1] ?? ""));
        const items = match?.[2] ?? "";
        let out = "";
        sorted().forEach((message, index) => {
          if (!uids.has(message.uid)) return;
          const seq = index + 1;
          const size = encoder.encode(message.source).length;
          if (items.includes("BODY.PEEK[]")) {
            out += `* ${seq} FETCH (UID ${message.uid} BODY[] ${literal(message.source)})\r\n`;
          } else {
            out +=
              `* ${seq} FETCH (UID ${message.uid} RFC822.SIZE ${size} FLAGS () ` +
              `INTERNALDATE "02-Nov-2026 09:15:01 +0100" ` +
              `BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)] ${literal(headersOf(message.source))})\r\n`;
          }
        });
        return `${out}${ok("Fetch completed")}`;
      }
      if (command === "LOGOUT") return `* BYE Logging out\r\n${ok("Logout completed")}`;
      return `${tag} BAD command not allowed in the fake mailbox\r\n`;
    },
    options,
  );
}
