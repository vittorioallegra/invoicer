import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../components/auth-layout";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { authClient } from "../lib/auth-client";
import { authErrorMessage } from "../lib/auth-errors";
import { IDLE_TIMEOUT_MS } from "../lib/sign-out";

const route = getRouteApi("/login");

type Stage = "credentials" | "totp" | "recovery";

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reason } = route.useSearch();
  const [stage, setStage] = useState<Stage>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = () => navigate({ to: "/", replace: true });

  async function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.message ?? t("auth.networkError"));
    } catch {
      setError(t("auth.networkError"));
    } finally {
      setBusy(false);
    }
  }

  const signInWithPasskey = () =>
    run(async () => {
      const { error: failure } = await authClient.signIn.passkey();
      if (failure)
        return { ok: false, message: authErrorMessage(failure, t, "auth.passkeyFailed") };
      await done();
      return { ok: true };
    });

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { data, error: failure } = await authClient.signIn.email({ email, password });
      if (failure) {
        return { ok: false, message: authErrorMessage(failure, t, "auth.invalidCredentials") };
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        setStage("totp");
        return { ok: true };
      }
      await done();
      return { ok: true };
    });
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const trimmed = code.trim();
      const { error: failure } =
        stage === "recovery"
          ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
          : await authClient.twoFactor.verifyTotp({ code: trimmed });
      if (failure) return { ok: false, message: authErrorMessage(failure, t, "auth.invalidCode") };
      await done();
      return { ok: true };
    });
  };

  const errorBanner = error ? <Banner tone="danger">{error}</Banner> : null;

  if (stage !== "credentials") {
    const recovery = stage === "recovery";
    return (
      <AuthLayout title={t("auth.secondFactorTitle")}>
        <form onSubmit={submitCode} className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {recovery ? t("auth.recoveryHint") : t("auth.totpHint")}
          </p>
          {errorBanner}
          <Field label={recovery ? t("auth.recoveryCode") : t("auth.totpCode")}>
            {(control) => (
              <Input
                {...control}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={recovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                autoCapitalize="none"
                required
              />
            )}
          </Field>
          <Button type="submit" disabled={busy}>
            {t("auth.verify")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setCode("");
              setError(null);
              setStage(recovery ? "totp" : "recovery");
            }}
          >
            {recovery ? t("auth.useTotp") : t("auth.useRecovery")}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.loginTitle")}>
      <div className="flex flex-col gap-4">
        {reason === "idle" ? (
          <Banner tone="info">
            {t("auth.signedOutIdle", { minutes: IDLE_TIMEOUT_MS / 60_000 })}
          </Banner>
        ) : null}
        {errorBanner}
        <Button onClick={signInWithPasskey} disabled={busy}>
          <KeyRound aria-hidden />
          {t("auth.signInWithPasskey")}
        </Button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {t("auth.orPassword")}
          <span className="h-px flex-1 bg-border" />
        </div>
        <form onSubmit={submitCredentials} className="flex flex-col gap-4">
          <Field label={t("auth.email")}>
            {(control) => (
              <Input
                {...control}
                type="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username webauthn"
                required
              />
            )}
          </Field>
          <Field label={t("auth.password")}>
            {(control) => (
              <Input
                {...control}
                type="password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" disabled={busy}>
            {t("auth.signIn")}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
