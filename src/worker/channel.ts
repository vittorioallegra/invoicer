import { createMockChannel } from "../shared/channel/mock";
import type { Channel } from "../shared/channel/types";
import { type Bindings, isMockChannel, requireSecrets } from "./env";
import type { PecServers } from "./pec/config";
import { createPecChannel } from "./pec/smtp";

/**
 * Picks the channel for a send. Called only after the send authorization was verified, so no
 * SMTP socket can exist before it. Tests swap `channelDeps.create` for a fake.
 */
export const channelDeps: { create: (env: Bindings, servers: PecServers) => Channel } = {
  create(env, servers) {
    if (isMockChannel(env)) return createMockChannel();
    requireSecrets(env, "pec");
    return createPecChannel(servers, {
      username: env.PEC_USERNAME as string,
      password: env.PEC_PASSWORD as string,
    });
  },
};
