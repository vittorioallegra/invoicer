import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Better Auth client: same-origin `/api/auth`, passkey and TOTP plugins. */
export const authClient = createAuthClient({
  plugins: [passkeyClient(), twoFactorClient()],
});

/** The user fields the app reads from a session. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled?: boolean | null;
}
