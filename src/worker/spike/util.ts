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

/** Tiny JSON store in R2 for spike state (credentials, subscriptions, callbacks). */
export async function readJson<T>(env: Bindings, key: string, fallback: T): Promise<T> {
  const object = await env.FILES.get(`spike/${key}.json`);
  return object ? ((await object.json()) as T) : fallback;
}

export async function writeJson(env: Bindings, key: string, value: unknown): Promise<void> {
  await env.FILES.put(`spike/${key}.json`, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function deleteJson(env: Bindings, key: string): Promise<void> {
  await env.FILES.delete(`spike/${key}.json`);
}
