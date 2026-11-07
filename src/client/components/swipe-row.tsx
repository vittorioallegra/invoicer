import { Trash2 } from "lucide-react";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "../lib/utils";

/** How far the row slides to show the Delete action (px). */
export const SWIPE_REVEAL_PX = 88;
/** A swipe shorter than this springs back instead of opening (px). */
const OPEN_THRESHOLD_PX = 36;
/** Movement before a touch counts as a horizontal swipe rather than a tap or a scroll (px). */
const INTENT_PX = 8;

/**
 * A list row that a finger can swipe to the left to reveal a red Delete action (the usual phone
 * gesture). Touch only: a mouse or keyboard uses the delete button inside the row, which stays
 * in the tab order. Vertical scrolling and taps on the row's own link keep working.
 */
export function SwipeRow({
  children,
  onDelete,
  label,
}: {
  children: ReactNode;
  onDelete: () => void;
  /** Accessible name and text of the revealed action. */
  label: string;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number } | null>(null);
  const horizontal = useRef(false);
  const suppressClick = useRef(false);
  const open = offset <= -SWIPE_REVEAL_PX + 1;

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    start.current = { x: event.clientX, y: event.clientY, base: offset };
    horizontal.current = false;
    suppressClick.current = false;
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (!horizontal.current) {
      if (Math.abs(dx) < INTENT_PX || Math.abs(dx) < Math.abs(dy)) return;
      horizontal.current = true;
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    suppressClick.current = true;
    setOffset(Math.max(-SWIPE_REVEAL_PX, Math.min(0, origin.base + dx)));
  };

  const finish = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (!horizontal.current) return;
    horizontal.current = false;
    setOffset((current) => (current <= -OPEN_THRESHOLD_PX ? -SWIPE_REVEAL_PX : 0));
  };

  return (
    <div className="relative overflow-hidden">
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={onDelete}
        className="absolute inset-y-0 right-0 flex w-22 flex-col items-center justify-center gap-1 bg-danger text-xs font-medium text-white"
      >
        <Trash2 aria-hidden className="size-5" />
        {label}
      </button>
      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          } else if (open) {
            // A tap on an open row closes it instead of following its link.
            event.preventDefault();
            event.stopPropagation();
            setOffset(0);
          }
        }}
        data-swipe=""
        data-open={open ? "" : undefined}
        style={{ transform: `translateX(${offset}px)` }}
        className={cn(
          "relative touch-pan-y bg-surface",
          dragging ? null : "transition-transform duration-150",
        )}
      >
        {children}
      </div>
    </div>
  );
}
