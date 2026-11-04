import { readApiError } from "../../shared/errors";

/** Same-origin JSON call to the Worker API. Failures throw a typed `ApiError`. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw await readApiError(response);
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

/**
 * Same-origin download of a stored file: its bytes and the file name the Worker gave it
 * (`Content-Disposition`), when it sent one. The viewer reads originals in the browser.
 */
export async function apiFile(
  path: string,
): Promise<{ bytes: Uint8Array; fileName: string | null }> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw await readApiError(response);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    fileName: /filename="([^"]+)"/.exec(disposition)?.[1] ?? null,
  };
}
