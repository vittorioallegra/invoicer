import { WorkerMailer } from "worker-mailer";
import { mapConnectError, mapSendError } from "../../shared/channel/errors";
import type { Channel, ChannelSendInput } from "../../shared/channel/types";
import { ChannelError } from "../../shared/channel/types";
import type { PecServers } from "./config";

export interface Mailer {
  send(email: Parameters<WorkerMailer["send"]>[0]): Promise<void>;
  close(): Promise<void>;
}
export type ConnectMailer = (
  options: Parameters<typeof WorkerMailer.connect>[0],
) => Promise<Mailer>;

export const connectWorkerMailer: ConnectMailer = (options) => WorkerMailer.connect(options);

export interface PecCredentials {
  username: string;
  password: string;
}

function mailerOptions(servers: PecServers, credentials: PecCredentials) {
  return {
    host: servers.smtpHost,
    port: servers.smtpPort,
    secure: true,
    startTls: false,
    authType: "plain" as const,
    credentials,
    // No library logging: it can echo server lines.
    logLevel: 4,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** SMTP login without sending (connection test). Throws a `ChannelError` on failure. */
export async function smtpLogin(
  servers: PecServers,
  credentials: PecCredentials,
  connect: ConnectMailer = connectWorkerMailer,
): Promise<void> {
  const secrets = [credentials.password, credentials.username];
  let mailer: Mailer;
  try {
    mailer = await connect(mailerOptions(servers, credentials));
  } catch (error) {
    throw mapConnectError(error, secrets);
  }
  await mailer.close().catch(() => undefined);
}

/** PEC channel: the FatturaPA XML as an attachment, from the mailbox to the SdI address. */
export function createPecChannel(
  servers: PecServers,
  credentials: PecCredentials,
  connect: ConnectMailer = connectWorkerMailer,
): Channel {
  const secrets = [credentials.password, credentials.username];
  return {
    id: "pec",
    async send(input: ChannelSendInput) {
      let mailer: Mailer;
      try {
        mailer = await connect(mailerOptions(servers, credentials));
      } catch (error) {
        throw mapConnectError(error, secrets);
      }
      try {
        await mailer.send({
          from: credentials.username,
          to: input.to,
          subject: input.fileName,
          text: `FatturaPA ${input.invoiceNumber}: ${input.fileName}`,
          headers: { "Message-ID": input.messageId },
          attachments: [
            {
              filename: input.fileName,
              content: toBase64(input.xml),
              mimeType: "application/xml",
            },
          ],
        });
      } catch (error) {
        throw error instanceof ChannelError ? error : mapSendError(error, secrets);
      } finally {
        await mailer.close().catch(() => undefined);
      }
      return { messageId: input.messageId };
    },
  };
}
