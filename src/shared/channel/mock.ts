import type { Channel } from "./types";

/** Dev channel: accepts everything, sends nothing. Never selected outside localhost. */
export function createMockChannel(): Channel {
  return {
    id: "mock",
    async send(input) {
      return { messageId: input.messageId };
    },
  };
}
