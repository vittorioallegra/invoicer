import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { pollMailbox } from "../pec/poll";
import { plainMail, sdiMessage } from "../pec/receipt-fixtures";
import { pollEnv, resetPolling, seedInvoice, useMailbox } from "../pec/test-support";

const bindings = env as unknown as Bindings;
let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.9.0.1", bindings));
  owner = new TestClient("10.9.0.2", bindings);
  await signIn(owner);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

describe("GET /api/mailbox/unmatched", () => {
  it("needs a session", async () => {
    const res = await new TestClient("10.9.0.3", bindings).json("/api/mailbox/unmatched");
    expect(res.status).toBe(401);
  });

  it("lists SdI messages no transmission claims, and only those", async () => {
    const inv = await seedInvoice(env.DB, { attempts: [{ fileName: "IT1_00001.xml" }] });
    useMailbox([
      { uid: 1, source: plainMail("noise") },
      { uid: 2, source: sdiMessage({ type: "RC", id: "claimed", fileName: "IT1_00001.xml" }) },
      { uid: 3, source: sdiMessage({ type: "NS", id: "stray", fileName: "IT7_00009.xml" }) },
    ]);
    await pollMailbox(pollEnv);
    expect(inv.id).toBeTruthy();
    const res = await owner.json<{ messages: { type: string; fileName: string }[] }>(
      "/api/mailbox/unmatched",
    );
    expect(res.status).toBe(200);
    expect(res.body.messages).toMatchObject([{ type: "NS", fileName: "IT7_00009.xml" }]);
  });
});
