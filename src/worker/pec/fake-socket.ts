import type { ImapSocket } from "./imap";

/**
 * Scripted IMAP server for tests. Each step expects one client line (a RegExp or an exact
 * string, tag included) and answers with `reply`. The greeting is sent when the socket is
 * created. `chunkSize` splits server output into small pieces to exercise buffering.
 * Test support only: never imported by Worker code.
 */
export interface ScriptStep {
  expect: string | RegExp;
  reply: string;
}

export interface FakeSocket extends ImapSocket {
  /** Client lines received so far (without CRLF). */
  received: string[];
  closed: boolean;
  /** Steps that were never reached. */
  remaining(): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function fakeSocket(
  greeting: string,
  script: readonly ScriptStep[],
  options: { chunkSize?: number } = {},
): FakeSocket {
  let step = 0;
  const socket = fakeServer(
    greeting,
    (line) => {
      const current = script[step++];
      const matches =
        current &&
        (typeof current.expect === "string" ? current.expect === line : current.expect.test(line));
      if (!current || !matches) {
        return `* BAD unexpected command in test script: ${line.split(" ")[0]}\r\n`;
      }
      return current.reply;
    },
    options,
  );
  socket.remaining = () => script.length - step;
  return socket;
}

/**
 * A fake server driven by a function: it receives each client line and returns what the server
 * answers (possibly nothing). Lets a test model a whole mailbox instead of a fixed transcript.
 */
export function fakeServer(
  greeting: string,
  respond: (line: string) => string,
  options: { chunkSize?: number } = {},
): FakeSocket {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pending = "";
  const received: string[] = [];
  const chunk = options.chunkSize ?? Number.POSITIVE_INFINITY;

  const send = (text: string) => {
    const bytes = encoder.encode(text);
    try {
      for (let i = 0; i < bytes.length; i += Math.min(chunk, bytes.length)) {
        controller.enqueue(bytes.slice(i, i + chunk));
      }
    } catch {
      // The test closed the socket.
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      send(greeting);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(data) {
      pending += decoder.decode(data);
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end === -1) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        received.push(line);
        send(respond(line));
      }
    },
  });

  const socket: FakeSocket = {
    readable,
    writable,
    received,
    closed: false,
    remaining: () => 0,
    close() {
      socket.closed = true;
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    },
  };
  return socket;
}

/** A synchronizing literal as the server sends it: `{n}CRLF` followed by the bytes. */
export function literal(text: string): string {
  return `{${encoder.encode(text).length}}\r\n${text}`;
}
