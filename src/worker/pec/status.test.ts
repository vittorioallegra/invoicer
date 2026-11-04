import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import { pushPayload } from "../push/deliver";
import { pollMailbox } from "./poll";
import { plainMail } from "./receipt-fixtures";
import { loadMailboxStatus } from "./status";
import { pollEnv, resetPolling, useMailbox } from "./test-support";

const notes = async () =>
  (
    await env.DB.prepare(
      "SELECT type, body, read_at AS readAt FROM notifications ORDER BY created_at",
    ).all<{
      type: string;
      body: string;
      readAt: number | null;
    }>()
  ).results;

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

describe("a failing mailbox login", () => {
  it("shows the warning with one push-worthy notification, and clears when polling works again", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    expect((await loadMailboxStatus(env.DB)).loginFailing).toBeNull();
    server.mailbox.loginOk = false;
    await pollMailbox(pollEnv);
    await pollMailbox(pollEnv);
    expect((await loadMailboxStatus(env.DB)).loginFailing).toMatchObject({
      at: expect.any(Number),
    });
    expect(await notes()).toEqual([{ type: "mailbox_login_failed", body: "{}", readAt: null }]);
    server.mailbox.loginOk = true;
    await pollMailbox(pollEnv);
    expect((await loadMailboxStatus(env.DB)).loginFailing).toBeNull();
  });
});

describe("the mailbox login notification as a push", () => {
  it("is written in the owner's language and opens the PEC settings", () => {
    const login = pushPayload("en", {
      id: "n2",
      type: "mailbox_login_failed",
      body: "{}",
      invoiceId: null,
    });
    expect(login).toMatchObject({ url: "/settings/pec", title: "PEC mailbox login failing" });
  });
});
