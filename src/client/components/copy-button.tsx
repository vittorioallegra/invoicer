import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

type CopyState = "idle" | "copied" | "failed";

const COPIED_MS = 2000;

/** Icon-only copy button with a short "Copied" state and an inline failure hint. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), COPIED_MS);
    } catch {
      setState("failed");
    }
  }

  const title = state === "copied" ? t("copy.copied") : label;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn(state === "copied" && "text-success", className)}
        aria-label={title}
        title={title}
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={state === "failed" ? "w-full px-1 pb-2 text-xs text-danger" : "sr-only"}
      >
        {state === "copied" ? t("copy.copied") : state === "failed" ? t("copy.failed") : ""}
      </span>
    </>
  );
}
