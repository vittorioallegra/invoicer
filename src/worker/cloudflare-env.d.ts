import type { Bindings } from "./env";

// Types `env` from "cloudflare:test" with the Worker bindings.
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
