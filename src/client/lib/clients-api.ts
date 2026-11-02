import type { ClientRecord } from "../../shared/client";
import { api } from "./api";

export const clientsQuery = {
  queryKey: ["clients"],
  queryFn: () => api<{ clients: ClientRecord[] }>("/api/clients"),
};

const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });

export const createClient = (body: unknown) =>
  send<{ client: ClientRecord }>("POST", "/api/clients", body);
export const updateClient = (id: string, body: unknown) =>
  send<{ client: ClientRecord }>("PUT", `/api/clients/${id}`, body);
export const deleteClient = (id: string) => send<null>("DELETE", `/api/clients/${id}`);
