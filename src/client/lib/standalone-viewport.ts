// iOS standalone web apps (seen on iOS 27) start with a layout viewport shorter than the
// window: innerHeight excludes the top safe area until the first scroll, so fixed elements
// anchored to the bottom (the tab bar) float above the home indicator. A 1 px scroll and back
// forces WebKit to recompute the viewport.
export function fixStandaloneViewport(win: Window = window) {
  const isStandalone = win.matchMedia("(display-mode: standalone)").matches;
  if (!isStandalone || win.innerHeight >= win.outerHeight) return;
  const root = win.document.documentElement;
  const previous = root.style.minHeight;
  root.style.minHeight = `${win.outerHeight + 1}px`;
  win.scrollTo(0, 1);
  win.requestAnimationFrame(() => {
    win.scrollTo(0, 0);
    root.style.minHeight = previous;
  });
}
