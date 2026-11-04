import { LogOut } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSignOut } from "../lib/sign-out";
import { Button } from "./ui/button";

/** "Sign out": ends the session and goes to the login screen. */
export function SignOutButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut().finally(() => setBusy(false));
      }}
    >
      <LogOut aria-hidden />
      {t("auth.signOut")}
    </Button>
  );
}
