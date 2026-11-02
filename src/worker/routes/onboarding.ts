import { Hono } from "hono";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { loadOnboarding } from "../onboarding";

export const onboarding = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/** Setup checklist (persisted state, resumable) and the send gate. */
onboarding.get("/", async (c) => c.json(await loadOnboarding(c.env, c.get("userId"))));
