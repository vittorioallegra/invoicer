import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUOTA_THRESHOLD_KB, ESTIMATED_MAILBOX_KB } from "../../shared/mailbox-quota";
import { applyMigrations } from "../auth/test-helpers";
import { lastFinishedRun } from "../jobs/job-runs";
import { runDailyTasks } from "../jobs/scheduled";
import { pushPayload } from "../push/deliver";
import { pollMailbox } from "./poll";
import { checkMailboxQuota, loadMailboxStatus } from "./quota";
import { plainMail } from "./receipt-fixtures";
import { pollEnv, resetPolling, useMailbox } from "./test-support";

const NOW = new Date("2026-06-10T07:00:00Z");
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

describe("mailbox quota check", () => {
  it("reads the quota the server reports and records it", async () => {
    const server = useMailbox();
    server.mailbox.quota = { usedKb: 16_936, limitKb: 1_024_000 };
    const result = await checkMailboxQuota(pollEnv, { now: NOW });
    expect(result).toEqual({
      ok: true,
      usedKb: 16_936,
      limitKb: 1_024_000,
      source: "server",
      low: false,
    });
    expect(await lastFinishedRun(env.DB, "quota")).toMatchObject({
      status: "success",
      runDate: "2026-06-10",
      counts: { usedKb: 16_936, limitKb: 1_024_000, source: "server" },
    });
    expect(await loadMailboxStatus(env.DB)).toMatchObject({
      loginFailing: null,
      thresholdKb: DEFAULT_QUOTA_THRESHOLD_KB,
      quota: { usedKb: 16_936, freeKb: 1_007_064, source: "server", low: false },
    });
    expect(await notes()).toEqual([]);
  });

  it("estimates from the stored messages when the server has no QUOTA", async () => {
    useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await env.DB.prepare(
      `INSERT INTO pec_messages (id, message_id, uid_validity, uid, kind, size, created_at)
       VALUES ('m1', '<a@x>', 1, 1, 'ignored', 3145728, 1), ('m2', '<b@x>', 1, 2, 'ignored', 1, 1)`,
    ).run();
    const result = await checkMailboxQuota(pollEnv, { now: NOW });
    expect(result).toEqual({
      ok: true,
      usedKb: 3073,
      limitKb: ESTIMATED_MAILBOX_KB,
      source: "estimate",
      low: false,
    });
    expect((await loadMailboxStatus(env.DB)).quota?.source).toBe("estimate");
  });

  it("flags a quota below the threshold on the banner, from the server and from the estimate", async () => {
    const server = useMailbox();
    server.mailbox.quota = { usedKb: 1_000_000, limitKb: 1_024_000 };
    expect(await checkMailboxQuota(pollEnv, { now: NOW })).toMatchObject({ ok: true, low: true });
    expect((await loadMailboxStatus(env.DB)).quota).toMatchObject({ freeKb: 24_000, low: true });
    // Raising or lowering the threshold changes the banner without another check.
    await env.DB.prepare(
      "INSERT INTO settings (id, mail_quota_threshold_kb) VALUES (1, 10240) ON CONFLICT(id) DO UPDATE SET mail_quota_threshold_kb = 10240",
    ).run();
    expect((await loadMailboxStatus(env.DB)).quota?.low).toBe(false);

    // No QUOTA on the server: the estimate against the assumed size.
    server.mailbox.quota = undefined;
    await env.DB.prepare("UPDATE settings SET mail_quota_threshold_kb = ?")
      .bind(ESTIMATED_MAILBOX_KB - 1000)
      .run();
    await env.DB.prepare(
      `INSERT INTO pec_messages (id, message_id, uid_validity, uid, kind, size, created_at)
       VALUES ('big', '<big@x>', 1, 1, 'ignored', 2097152, 1)`,
    ).run();
    expect(await checkMailboxQuota(pollEnv, { now: NOW })).toMatchObject({
      ok: true,
      source: "estimate",
      low: true,
    });
  });

  it("sends one notification from the daily job, until it is read, and none from a manual check", async () => {
    const server = useMailbox();
    server.mailbox.quota = { usedKb: 1_000_000, limitKb: 1_024_000 };
    await checkMailboxQuota(pollEnv, { now: NOW });
    expect(await notes()).toEqual([]);
    const first = await runDailyTasks(pollEnv, NOW);
    expect(first.counts).toMatchObject({ quota: 1 });
    await runDailyTasks(pollEnv, new Date("2026-06-11T07:00:00Z"));
    expect(await notes()).toEqual([
      {
        type: "mailbox_quota_low",
        body: JSON.stringify({ freeMb: 23, thresholdMb: 50 }),
        readAt: null,
      },
    ]);
    await env.DB.prepare("UPDATE notifications SET read_at = 1").run();
    await runDailyTasks(pollEnv, new Date("2026-06-12T07:00:00Z"));
    expect(await notes()).toHaveLength(2);
  });

  it("is skipped without PEC secrets and fails softly on a refused login", async () => {
    expect(await checkMailboxQuota(env as never)).toBeNull();
    const server = useMailbox();
    server.mailbox.loginOk = false;
    expect(await checkMailboxQuota(pollEnv, { now: NOW })).toEqual({
      ok: false,
      errorCode: "login_failed",
    });
    expect(await lastFinishedRun(env.DB, "quota")).toMatchObject({
      status: "failed",
      errorCode: "login_failed",
    });
    // A failed check never replaces the last known quota.
    expect((await loadMailboxStatus(env.DB)).quota).toBeNull();
    expect((await runDailyTasks(pollEnv, NOW)).counts).toMatchObject({ quota: 0 });
  });
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

describe("the mailbox notifications as pushes", () => {
  it("are written in the owner's language and open the PEC settings", () => {
    const quota = pushPayload("it", {
      id: "n1",
      type: "mailbox_quota_low",
      body: JSON.stringify({ freeMb: 23, thresholdMb: 50 }),
      invoiceId: null,
    });
    expect(quota).toMatchObject({ tag: "n1", url: "/settings/pec" });
    expect(quota.body).toContain("23");
    expect(quota.body).not.toContain("{{");
    const login = pushPayload("en", {
      id: "n2",
      type: "mailbox_login_failed",
      body: "{}",
      invoiceId: null,
    });
    expect(login).toMatchObject({ url: "/settings/pec", title: "PEC mailbox login failing" });
  });
});
