import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { loadOriginal } from "../import/original";
import { summarizeInvoice } from "../import/summary";
import { receivedFileUrl, reportParsed } from "./received-api";

/**
 * The Worker never parses invoices (10 ms CPU limit), so a received invoice found by the mailbox
 * poll waits as `pending` until a browser reads its file. This reads the pending ones one at a time
 * and reports each summary back; a file that cannot be read is reported as failed. Each invoice is
 * tried once per page load, so a failing report never loops.
 */
export function useReadPending(items: ReceivedInvoiceRecord[] | undefined): {
  reading: boolean;
  remaining: number;
} {
  const queryClient = useQueryClient();
  const tried = useRef(new Set<string>());
  const running = useRef(false);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const todo = (items ?? []).filter(
      (item) => item.parseStatus === "pending" && !tried.current.has(item.id),
    );
    setRemaining(todo.length);
    if (todo.length === 0 || running.current) return;
    running.current = true;
    void (async () => {
      for (const [index, item] of todo.entries()) {
        tried.current.add(item.id);
        try {
          const original = item.original;
          const loaded = await loadOriginal(
            receivedFileUrl(item.id),
            original?.fileName ?? "invoice.xml",
            original?.kind ?? "received",
          );
          const summary = summarizeInvoice(loaded.invoice);
          await reportParsed(item.id, summary ? { summary } : null);
        } catch {
          await reportParsed(item.id, null).catch(() => undefined);
        }
        setRemaining(todo.length - index - 1);
      }
      running.current = false;
      await queryClient.invalidateQueries({ queryKey: ["received"] });
    })();
  }, [items, queryClient]);

  return { reading: remaining > 0, remaining };
}
