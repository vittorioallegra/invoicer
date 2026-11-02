// Temporary viewport diagnostics for the iOS PWA layout bug; removed together with the spike page (step 21).
// Throwaway UI: English strings are intentionally not routed through i18n.
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";

export type Snapshot = Record<string, string>;
type Row = { label: string; key: string };

const PROBE_HEIGHTS = ["100vh", "100svh", "100lvh", "100dvh", "100%"] as const;
const INSETS = ["top", "right", "bottom", "left"] as const;

export const ROWS: Row[] = [
  "userAgent",
  "standalone (display-mode)",
  "navigator.standalone",
  "screen WxH",
  "devicePixelRatio",
  "window innerW x innerH",
  "documentElement.clientHeight",
  "visualViewport WxH",
  "visualViewport offsetTop",
  "visualViewport pageTop",
  "window.scrollY",
  "documentElement.scrollHeight",
  "body.scrollHeight",
  ...INSETS.map((side) => `safe-area-inset-${side}`),
  ...PROBE_HEIGHTS.map((h) => `probe height ${h}`),
  "shell-root rect (top/bottom/height)",
  "main rect (top/bottom/height)",
  "tab-bar rect (top/bottom/height)",
  "html background-color",
  "body background-color",
].map((label) => ({ label, key: label }));

function rect(name: string): string {
  const el = document.querySelector(`[data-diagnostics="${name}"]`);
  if (!el) return "n/a";
  const r = el.getBoundingClientRect();
  return `${r.top.toFixed(1)} / ${r.bottom.toFixed(1)} / ${r.height.toFixed(1)}`;
}

function probe(style: Partial<CSSStyleDeclaration>, read: (cs: CSSStyleDeclaration) => string[]) {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    top: "0",
    left: "0",
    width: "1px",
    ...style,
  });
  document.body.appendChild(el);
  try {
    return read(getComputedStyle(el));
  } finally {
    el.remove();
  }
}

export function takeSnapshot(): Snapshot {
  const vv = window.visualViewport;
  const de = document.documentElement;
  const standaloneNav = (navigator as unknown as { standalone?: boolean }).standalone;
  const insets = probe(
    {
      paddingTop: "env(safe-area-inset-top)",
      paddingRight: "env(safe-area-inset-right)",
      paddingBottom: "env(safe-area-inset-bottom)",
      paddingLeft: "env(safe-area-inset-left)",
    },
    (cs) => [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
  );
  const snap: Snapshot = {
    userAgent: navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 80),
    "standalone (display-mode)": String(window.matchMedia?.("(display-mode: standalone)").matches),
    "navigator.standalone": String(standaloneNav),
    "screen WxH": `${screen.width} x ${screen.height}`,
    devicePixelRatio: String(window.devicePixelRatio),
    "window innerW x innerH": `${window.innerWidth} x ${window.innerHeight}`,
    "documentElement.clientHeight": String(de.clientHeight),
    "visualViewport WxH": vv ? `${vv.width} x ${vv.height}` : "n/a",
    "visualViewport offsetTop": vv ? String(vv.offsetTop) : "n/a",
    "visualViewport pageTop": vv ? String(vv.pageTop) : "n/a",
    "window.scrollY": String(window.scrollY),
    "documentElement.scrollHeight": String(de.scrollHeight),
    "body.scrollHeight": String(document.body.scrollHeight),
    "shell-root rect (top/bottom/height)": rect("shell-root"),
    "main rect (top/bottom/height)": rect("main"),
    "tab-bar rect (top/bottom/height)": rect("tab-bar"),
    "html background-color": getComputedStyle(de).backgroundColor,
    "body background-color": getComputedStyle(document.body).backgroundColor,
  };
  INSETS.forEach((side, i) => {
    snap[`safe-area-inset-${side}`] = insets[i] ?? "";
  });
  for (const h of PROBE_HEIGHTS) {
    snap[`probe height ${h}`] = probe({ height: h }, (cs) => [cs.height])[0] ?? "";
  }
  return snap;
}

export function formatDiagnostics(first: Snapshot | null, now: Snapshot, meta: string): string {
  const lines = [meta, `${"key".padEnd(38)} | first paint | now`];
  for (const { label } of ROWS) {
    lines.push(`${label.padEnd(38)} | ${first?.[label] ?? "-"} | ${now[label] ?? "-"}`);
  }
  return lines.join("\n");
}

async function copyText(text: string, fallback: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallback) return false;
    fallback.hidden = false;
    fallback.value = text;
    fallback.focus();
    fallback.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

export function ViewportDiagnostics() {
  const [now, setNow] = useState<Snapshot>(() => takeSnapshot());
  const [first, setFirst] = useState<Snapshot | null>(null);
  const [count, setCount] = useState(1);
  const [updatedAt, setUpdatedAt] = useState(() => new Date().toISOString());
  const [firstAt, setFirstAt] = useState("");
  const [status, setStatus] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const update = () => {
      setNow(takeSnapshot());
      setCount((c) => c + 1);
      setUpdatedAt(new Date().toISOString());
    };
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const snap = takeSnapshot();
        setFirst(snap);
        setFirstAt(new Date().toISOString());
        console.info("[viewport-diagnostics] first paint", snap);
        update();
      });
    });
    const vv = window.visualViewport;
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("scroll", update, { passive: true });
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("scroll", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, []);

  const meta = `updates: ${count}, last update: ${updatedAt}, first paint at: ${firstAt || "-"}`;

  async function copy() {
    const ok = await copyText(formatDiagnostics(first, now, meta), textarea.current);
    setStatus(ok ? "Copied" : "Copy failed: select the text below manually");
  }

  return (
    <section className="flex flex-col gap-2" data-testid="viewport-diagnostics">
      <h2 className="text-lg font-medium">Viewport diagnostics</h2>
      <p className="font-mono text-xs text-muted-foreground">{meta}</p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[0.6875rem] leading-tight">
          <thead>
            <tr className="text-left">
              <th className="pr-2">key</th>
              <th className="pr-2">first paint</th>
              <th>now</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(({ label, key }) => (
              <tr key={key} className="border-t border-border align-top">
                <td className="pr-2 break-words">{label}</td>
                <td className="pr-2 break-words">{first?.[key] ?? "-"}</td>
                <td className="break-words">{now[key]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" onClick={copy}>
          Copy diagnostics
        </Button>
        <span className="text-xs">{status}</span>
      </div>
      <textarea ref={textarea} hidden readOnly rows={8} className="w-full font-mono text-xs" />
    </section>
  );
}
