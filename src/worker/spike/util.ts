import type { Bindings } from "../env";

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Wall-clock helper. In deployed Workers the clock only advances on I/O (timing side-channel
 * mitigation), so a CPU-only section usually reads 0 ms there; real CPU time is read from
 * `wrangler tail` / the dashboard (see docs/notes/spike.md). Locally it is meaningful.
 */
export async function timed<T>(run: () => Promise<T> | T): Promise<{ value: T; clockMs: number }> {
  const start = performance.now();
  const value = await run();
  return { value, clockMs: Math.round((performance.now() - start) * 100) / 100 };
}

/**
 * Tiny JSON store in D1 for spike state (credentials, subscriptions, callbacks). The throwaway
 * `spike_kv` table is created at runtime, not by a migration, and dropped when the spike is
 * removed (step 20).
 */
async function ensureTable(env: Bindings): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS spike_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
}

export async function readJson<T>(env: Bindings, key: string, fallback: T): Promise<T> {
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT value FROM spike_kv WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export async function writeJson(env: Bindings, key: string, value: unknown): Promise<void> {
  await ensureTable(env);
  await env.DB.prepare(
    "INSERT INTO spike_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

export async function deleteJson(env: Bindings, key: string): Promise<void> {
  await ensureTable(env);
  await env.DB.prepare("DELETE FROM spike_kv WHERE key = ?").bind(key).run();
}
