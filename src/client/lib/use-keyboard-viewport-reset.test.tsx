import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYBOARD_SETTLE_MS, useKeyboardViewportReset } from "./use-keyboard-viewport-reset";

function Probe() {
  useKeyboardViewportReset();
  return <input aria-label="field" />;
}

describe("useKeyboardViewportReset", () => {
  const scrollTo = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    scrollTo.mockClear();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 40, configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("nudges the scroll position by one pixel and back once the keyboard is dismissed", () => {
    const { getByLabelText } = render(<Probe />);
    const field = getByLabelText("field");
    field.focus();
    act(() => {
      field.blur();
      vi.advanceTimersByTime(KEYBOARD_SETTLE_MS + 1);
    });
    expect(scrollTo.mock.calls).toEqual([
      [0, 39],
      [0, 40],
    ]);
  });

  it("goes down by one when the page is at the top, and always returns to where it was", () => {
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    const { getByLabelText } = render(<Probe />);
    const field = getByLabelText("field");
    field.focus();
    act(() => {
      field.blur();
      vi.advanceTimersByTime(KEYBOARD_SETTLE_MS + 1);
    });
    expect(scrollTo.mock.calls).toEqual([
      [0, 1],
      [0, 0],
    ]);
  });

  it("does nothing while focus moves to another field", () => {
    const { getByLabelText } = render(
      <>
        <Probe />
        <input aria-label="other" />
      </>,
    );
    const field = getByLabelText("field");
    field.focus();
    act(() => {
      getByLabelText("other").focus();
      vi.advanceTimersByTime(KEYBOARD_SETTLE_MS + 1);
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
