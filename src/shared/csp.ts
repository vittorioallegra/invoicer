/**
 * Content-Security-Policy for the SPA. Static assets are served by the Workers assets layer,
 * so the same string lives in `public/_headers` (a test keeps them identical).
 * No inline script; `connect-src 'self'` means the browser never calls the PEC servers or any third
 * party: all external calls go through the Worker. Inline style attributes are allowed (Radix
 * positions overlays with them), inline style elements are not. `'wasm-unsafe-eval'` only lets the
 * browser compile WebAssembly (the XSD validator `xmllint-wasm` that Finalize runs); it does not
 * allow `eval()` or any script string.
 */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
