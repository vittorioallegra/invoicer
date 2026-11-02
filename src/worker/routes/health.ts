import { Hono } from "hono";
import type { Bindings } from "../env";

export const health = new Hono<{ Bindings: Bindings }>();

health.get("/", (c) => c.json({ status: "ok" }));
