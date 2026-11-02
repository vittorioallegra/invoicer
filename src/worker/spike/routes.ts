import { Hono } from "hono";
import type { Bindings } from "../env";
import { cpu } from "./cpu";
import { spikeGate } from "./gate";
import { callbackReceiver, openapi } from "./openapi";
import { passkey } from "./passkey";
import { push } from "./push";

/**
 * Mounted under /api/webhooks/ (exempt from the Origin check) because Openapi calls it itself;
 * it does its own secret check instead of the header gate.
 */
export const spikeCallback = callbackReceiver;

export const spike = new Hono<{ Bindings: Bindings }>();

spike.use("*", spikeGate);
spike.get("/ping", (c) => c.json({ ok: true }));
spike.route("/passkey", passkey);
spike.route("/push", push);
spike.route("/cpu", cpu);
spike.route("/openapi", openapi);
