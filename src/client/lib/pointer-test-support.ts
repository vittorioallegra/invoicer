/** Test helper: makes `matchMedia("(pointer: coarse)")` answer `coarse`, with the jsdom gaps Radix needs. */
export function setPointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("coarse") ? coarse : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
  (globalThis as Record<string, unknown>).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

export function resetPointer(): void {
  Reflect.deleteProperty(window, "matchMedia");
}
