// Temporary risk-spike page (plan step 2), removed in step 20. Hidden: not linked from the app.
// Throwaway UI: English strings are intentionally not routed through i18n.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

type Outcome = "PASS" | "FAIL" | "INFO";
interface LogRow {
  time: string;
  label: string;
  outcome: Outcome;
  wallMs: number;
  detail: string;
}

const STORAGE_KEY = "spike-secret";
const PBKDF2_COUNTS = [1000, 5000, 10000, 20000, 50000, 100000, 200000];
const BIND_OK = "invoice-1|sha256-of-final-xml";

function loadSecret(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function urlBase64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function deviceLabel(): string {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  const platform = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "Mac/desktop";
  return `${platform} ${standalone ? "Home screen PWA" : "browser tab"}`;
}

export function SpikePage() {
  const [secret, setSecret] = useState(loadSecret);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [fiscalId, setFiscalId] = useState("");
  const [recipientCode, setRecipientCode] = useState("0000000");
  const [raw, setRaw] = useState("");

  function log(label: string, outcome: Outcome, wallMs: number, detail: unknown) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    setRows((previous) => [
      { time: new Date().toLocaleTimeString(), label, outcome, wallMs, detail: text.slice(0, 400) },
      ...previous,
    ]);
  }

  async function call(path: string, init: { method?: string; body?: unknown } = {}) {
    const started = performance.now();
    const response = await fetch(`/api/spike${path}`, {
      method: init.method ?? "GET",
      headers: {
        "X-Spike-Secret": secret,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, json, wallMs: Math.round(performance.now() - started) };
  }

  async function run(label: string, action: () => Promise<{ outcome: Outcome; detail: unknown }>) {
    setBusy(true);
    const started = performance.now();
    try {
      const { outcome, detail } = await action();
      log(label, outcome, Math.round(performance.now() - started), detail);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      log(label, "FAIL", Math.round(performance.now() - started), message);
    } finally {
      setBusy(false);
    }
  }

  function saveSecret(value: string) {
    setSecret(value);
    try {
      sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Storage can be blocked; the secret then only lives in memory.
    }
  }

  const ping = () =>
    run("Gate / ping", async () => {
      const r = await call("/ping");
      return { outcome: r.status === 200 ? "PASS" : "FAIL", detail: `HTTP ${r.status}` };
    });

  const registerPasskey = () =>
    run(`Passkey register (${deviceLabel()})`, async () => {
      const options = await call("/passkey/register/options", { method: "POST", body: {} });
      if (options.status !== 200) return { outcome: "FAIL", detail: options.json };
      const response = await startRegistration({ optionsJSON: options.json as never });
      const verified = await call("/passkey/register/verify", { method: "POST", body: response });
      return { outcome: verified.json.verified === true ? "PASS" : "FAIL", detail: verified.json };
    });

  const authenticate = (label: string, verifyBind: string, expectPass: boolean) =>
    run(`${label} (${deviceLabel()})`, async () => {
      const options = await call("/passkey/auth/options", {
        method: "POST",
        body: { bind: BIND_OK },
      });
      if (options.status !== 200) return { outcome: "FAIL", detail: options.json };
      const response = await startAuthentication({
        optionsJSON: (options.json as { options: never }).options,
      });
      const verified = await call("/passkey/auth/verify", {
        method: "POST",
        body: { response, bind: verifyBind },
      });
      const ok = (verified.json.verified === true) === expectPass;
      return { outcome: ok ? "PASS" : "FAIL", detail: verified.json };
    });

  const subscribePush = () =>
    run(`Push subscribe (${deviceLabel()})`, async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        return {
          outcome: "FAIL",
          detail: "Push not supported here (iPhone: open from the Home screen).",
        };
      }
      const config = await call("/push/config");
      const publicKey = config.json.publicKey as string | null;
      if (!publicKey) return { outcome: "FAIL", detail: "VAPID_PUBLIC_KEY is not configured." };
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return { outcome: "FAIL", detail: `Permission: ${permission}` };
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBytes(publicKey),
        }));
      const stored = await call("/push/subscribe", {
        method: "POST",
        body: { subscription: subscription.toJSON(), label: deviceLabel() },
      });
      return {
        outcome: stored.status === 200 ? "PASS" : "FAIL",
        detail: `Subscribed, HTTP ${stored.status}`,
      };
    });

  const sendPush = (delaySeconds: number) =>
    run(delaySeconds ? `Push send in ${delaySeconds} s` : "Push send now", async () => {
      const r = await call("/push/send", { method: "POST", body: { delaySeconds } });
      return {
        outcome: r.status === 200 ? "INFO" : "FAIL",
        detail: delaySeconds
          ? "Scheduled. Close the app now; the notification should appear within about 30 s."
          : r.json,
      };
    });

  const lastPush = () =>
    run("Push: subscriptions and last send", async () => {
      const r = await call("/push/subscriptions");
      return { outcome: "INFO", detail: r.json };
    });

  const cpuProbe = (name: string, query = "") =>
    run(`CPU ${name}${query}`, async () => {
      const r = await call(`/cpu/${name}${query}`, { method: "POST" });
      const ok = r.json.ok === true;
      return {
        outcome: ok ? "PASS" : "FAIL",
        detail: `HTTP ${r.status}; in-Worker clock ${String(r.json.clockMs)} ms; ${JSON.stringify(r.json.detail ?? r.json.error ?? r.json)}`,
      };
    });

  const runAllCpu = async () => {
    for (const count of PBKDF2_COUNTS) await cpuProbe("pbkdf2", `?iterations=${count}`);
    for (const name of ["passkey-verify", "push-encrypt", "callback-parse", "openapi-dry-run"]) {
      await cpuProbe(name);
    }
  };

  const sandboxFlow = () =>
    run("Openapi sandbox flow", async () => {
      const r = await call("/openapi/sandbox-flow", {
        method: "POST",
        body: { fiscalId, recipientCode },
      });
      setRaw(JSON.stringify(r.json, null, 2));
      return {
        outcome: r.status === 200 ? "INFO" : "FAIL",
        detail: `HTTP ${r.status}; see raw output below.`,
      };
    });

  const callbacks = (path: string, method = "GET", body?: unknown) =>
    run(`Openapi callbacks ${method} ${path}`, async () => {
      const r = await call(`/openapi${path}`, { method, ...(body ? { body } : {}) });
      setRaw(JSON.stringify(r.json, null, 2));
      return { outcome: "INFO", detail: `HTTP ${r.status}; see raw output below.` };
    });

  const copy = () =>
    navigator.clipboard?.writeText(
      rows.map((r) => `${r.outcome}\t${r.label}\t${r.wallMs} ms\t${r.detail}`).join("\n"),
    );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Risk spike</h1>
      <p className="text-sm text-muted-foreground">
        Temporary page (removed in step 20). Device: {deviceLabel()}. Instructions:
        docs/notes/spike.md.
      </p>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Spike secret</h2>
        <Input
          type="password"
          autoComplete="off"
          placeholder="SPIKE_SECRET"
          value={secret}
          onChange={(event) => saveSecret(event.target.value)}
        />
        <Button variant="secondary" disabled={busy || !secret} onClick={ping}>
          Check gate
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">1. Passkey</h2>
        <Button disabled={busy || !secret} onClick={registerPasskey}>
          Register passkey
        </Button>
        <Button
          disabled={busy || !secret}
          onClick={() => authenticate("Passkey assertion", BIND_OK, true)}
        >
          Sign in with passkey (bound challenge)
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !secret}
          onClick={() =>
            authenticate("Passkey wrong binding must be refused", "invoice-2|other-hash", false)
          }
        >
          Wrong binding must be refused
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !secret}
          onClick={() =>
            run("Passkey: stored credentials", async () => ({
              outcome: "INFO",
              detail: (await call("/passkey/credentials")).json,
            }))
          }
        >
          List stored credentials
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !secret}
          onClick={() =>
            run("Passkey: clear credentials", async () => ({
              outcome: "INFO",
              detail: (await call("/passkey/credentials", { method: "DELETE" })).json,
            }))
          }
        >
          Clear stored credentials
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">2. Web Push</h2>
        <Button disabled={busy || !secret} onClick={subscribePush}>
          Subscribe this device
        </Button>
        <Button variant="secondary" disabled={busy || !secret} onClick={() => sendPush(0)}>
          Send push now
        </Button>
        <Button variant="secondary" disabled={busy || !secret} onClick={() => sendPush(20)}>
          Send push in 20 s (then close the app)
        </Button>
        <Button variant="ghost" disabled={busy || !secret} onClick={lastPush}>
          Show subscriptions / last send
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !secret}
          onClick={() =>
            run("Push: clear subscriptions", async () => ({
              outcome: "INFO",
              detail: (await call("/push/subscriptions", { method: "DELETE" })).json,
            }))
          }
        >
          Clear subscriptions
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">3. CPU probes</h2>
        <p className="text-sm text-muted-foreground">
          One request per probe. Read the per-request CPU time with <code>wrangler tail</code>{" "}
          (docs/notes/spike.md).
        </p>
        <Button disabled={busy || !secret} onClick={runAllCpu}>
          Run all probes
        </Button>
        <div className="flex flex-wrap gap-2">
          {PBKDF2_COUNTS.map((count) => (
            <Button
              key={count}
              size="sm"
              variant="secondary"
              disabled={busy || !secret}
              onClick={() => cpuProbe("pbkdf2", `?iterations=${count}`)}
            >
              PBKDF2 {count}
            </Button>
          ))}
          {["passkey-verify", "push-encrypt", "callback-parse", "openapi-dry-run"].map((name) => (
            <Button
              key={name}
              size="sm"
              variant="secondary"
              disabled={busy || !secret}
              onClick={() => cpuProbe(name)}
            >
              {name}
            </Button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">4. Openapi sandbox</h2>
        <p className="text-sm text-muted-foreground">
          Needs the OPENAPI_SANDBOX_TOKEN secret; otherwise it reports "skipped".
        </p>
        <Input
          inputMode="numeric"
          placeholder="Sandbox fiscal ID (11 digits)"
          value={fiscalId}
          onChange={(event) => setFiscalId(event.target.value)}
        />
        <Input
          placeholder="Codice destinatario"
          value={recipientCode}
          onChange={(event) => setRecipientCode(event.target.value)}
        />
        <Button disabled={busy || !secret || fiscalId.length !== 11} onClick={sandboxFlow}>
          Send + simulate receipt + supplier invoice
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !secret}
            onClick={() => callbacks("/callbacks")}
          >
            Show recorded callbacks
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !secret}
            onClick={() => callbacks("/callback-mode", "POST", { mode: "fail" })}
          >
            Callback answers 500
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !secret}
            onClick={() => callbacks("/callback-mode", "POST", { mode: "ok" })}
          >
            Callback answers 200
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !secret}
            onClick={() => callbacks("/callbacks", "DELETE")}
          >
            Clear callbacks
          </Button>
        </div>
        {raw ? (
          <pre className="max-h-96 overflow-auto rounded-control border border-border p-2 text-xs">
            {raw}
          </pre>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Results</h2>
        <Button size="sm" variant="ghost" onClick={copy} disabled={rows.length === 0}>
          Copy results
        </Button>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing run yet.</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
            <li key={index} className="rounded-control border border-border p-2 text-sm">
              <strong>{row.outcome}</strong> {row.label}{" "}
              <span className="text-muted-foreground">
                ({row.wallMs} ms wall, {row.time})
              </span>
              <div className="break-all text-xs text-muted-foreground">{row.detail}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
