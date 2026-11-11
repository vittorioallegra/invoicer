import { beforeEach } from "vitest";

// Worker tests run the PEC work in place: their fake sockets and mailers are module state that a
// Durable Object would not share. `pec/poller.test.ts` covers the placed path with a fake stub.
// Imported inside the hook, not at the top: a test file's `vi.mock` of the socket module must be
// registered before anything loads it.
beforeEach(async () => {
  const { pollerDeps } = await import("./pec/poller");
  pollerDeps.stub = () => null;
});
