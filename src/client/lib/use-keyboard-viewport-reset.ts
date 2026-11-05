import { useEffect } from "react";

/** How long iOS needs to finish closing the keyboard before the viewport is re-evaluated. */
export const KEYBOARD_SETTLE_MS = 150;

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function isEditing(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches(EDITABLE);
}

/**
 * Nudges the scroll position by one pixel and back, which makes iOS re-measure the viewport.
 * Net effect on the page: none.
 */
export function nudgeViewport(): void {
  const y = window.scrollY;
  window.scrollTo(0, y > 0 ? y - 1 : 1);
  window.scrollTo(0, y);
}

/**
 * iOS Safari (above all the home-screen app) keeps the layout viewport at the keyboard's size
 * after the keyboard closes: fixed bars such as the tab bar then float above a dark strip until
 * the next scroll. When the keyboard is dismissed, re-measure the viewport once.
 */
export function useKeyboardViewportReset(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isEditing()) nudgeViewport();
      }, KEYBOARD_SETTLE_MS);
    };

    const viewport = window.visualViewport;
    let wasShrunk = false;
    const onViewportResize = () => {
      if (!viewport) return;
      const shrunk = viewport.height < window.innerHeight - 100;
      if (wasShrunk && !shrunk) schedule();
      wasShrunk = shrunk;
    };

    document.addEventListener("focusout", schedule);
    viewport?.addEventListener("resize", onViewportResize);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("focusout", schedule);
      viewport?.removeEventListener("resize", onViewportResize);
    };
  }, []);
}
