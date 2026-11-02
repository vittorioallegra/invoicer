import { Hono } from "hono";
import type { Bindings } from "../env";
import { cpu } from "./cpu";
import { spikeGate } from "./gate";
import { passkey } from "./passkey";
import { pec } from "./pec";
import { push } from "./push";

export const spike = new Hono<{ Bindings: Bindings }>();

spike.use("*", spikeGate);
spike.get("/ping", (c) => c.json({ ok: true }));
spike.route("/passkey", passkey);
spike.route("/push", push);
spike.route("/cpu", cpu);
spike.route("/pec", pec);
