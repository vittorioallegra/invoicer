import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../components/auth-layout";
import { CopyButton } from "../components/copy-button";
import { QrCode } from "../components/qr-code";
import { Banner } from "../components/ui/banner";
import { Button, buttonVariants } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { authClient, type SessionUser } from "../lib/auth-client";
import { authErrorMessage } from "../lib/auth-errors";

type Step = "create" | "totp" | "codes" | "passkey";

/** Safari's strong-password generator follows these rules (the server needs 12 to 128 characters). */
const PASSWORD_RULES = {
  passwordrules:
    "minlength: 20; maxlength: 128; required: lower; required: upper; required: digit;",
} as Record<string, string>;

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 24 random characters (about 140 bits), unbiased by rejection sampling. */
export function generatePassword(length = 24): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && out.length < length)
        out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

function useAction() {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      setError(await action());
    } catch {
      setError(t("auth.networkError"));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, banner: error ? <Banner tone="danger">{error}</Banner> : null };
}

function CreateOwner({ onCreated }: { onCreated: (password: string) => void }) {
  const { t } = useTranslation();
  const { run, busy, banner } = useAction();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, name, email, password }),
        });
      } catch (caught) {
        const code = (caught as { code?: string }).code;
        if (code === "forbidden") return t("auth.setupTokenInvalid");
        if (code === "missing_secret") return t("auth.setupTokenMissing");
        if (code === "conflict") return t("auth.setupClosed");
        if (code === "bad_request") return t("auth.setupInvalid");
        return t("auth.networkError");
      }
      const { error: failure } = await authClient.signIn.email({ email, password });
      if (failure) return authErrorMessage(failure, t, "auth.invalidCredentials");
      onCreated(password);
      return null;
    });
  };

  return (
    <AuthLayout title={t("auth.setupTitle")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t("auth.setupIntro")}</p>
        {banner}
        <Field label={t("auth.setupToken")} hint={t("auth.setupTokenHint")}>
          {(control) => (
            <Input
              {...control}
              name="setup-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              required
            />
          )}
        </Field>
        <Field label={t("auth.name")}>
          {(control) => (
            <Input
              {...control}
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          )}
        </Field>
        <Field label={t("auth.email")}>
          {(control) => (
            <Input
              {...control}
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          )}
        </Field>
        <Field label={t("auth.password")} hint={t("auth.passwordHint")}>
          {(control) => (
            <Input
              {...control}
              type={reveal ? "text" : "password"}
              name="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              {...PASSWORD_RULES}
              minLength={12}
              maxLength={128}
              required
            />
          )}
        </Field>
        <Button
          variant="secondary"
          onClick={() => {
            setPassword(generatePassword());
            setReveal(true);
          }}
        >
          {t("auth.generatePassword")}
        </Button>
        <Button type="submit" disabled={busy}>
          {t("auth.createOwner")}
        </Button>
      </form>
    </AuthLayout>
  );
}

function secretOf(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

function EnrollTotp({
  initialPassword,
  onEnrolled,
}: {
  initialPassword: string | undefined;
  onEnrolled: (recoveryCodes: string[]) => void;
}) {
  const { t } = useTranslation();
  const { run, busy, banner } = useAction();
  const [password, setPassword] = useState(initialPassword ?? "");
  const [enrolment, setEnrolment] = useState<{ uri: string; codes: string[] } | null>(null);
  const [code, setCode] = useState("");

  const start = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { data, error: failure } = await authClient.twoFactor.enable({ password });
      if (failure || data?.method !== "totp") {
        return authErrorMessage(failure, t, "auth.invalidCredentials");
      }
      setEnrolment({ uri: data.totpURI, codes: data.backupCodes });
      return null;
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { error: failure } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (failure) return authErrorMessage(failure, t, "auth.invalidCode");
      onEnrolled(enrolment?.codes ?? []);
      return null;
    });
  };

  if (!enrolment) {
    return (
      <AuthLayout title={t("auth.totpSetupTitle")}>
        <form onSubmit={start} className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t("auth.totpSetupIntro")}</p>
          {banner}
          {initialPassword ? null : (
            <Field label={t("auth.password")}>
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              )}
            </Field>
          )}
          <Button type="submit" disabled={busy}>
            {t("auth.totpStart")}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.totpSetupTitle")}>
      <form onSubmit={confirm} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t("auth.totpScan")}</p>
        <div className="flex flex-col items-center gap-2">
          <QrCode text={enrolment.uri} label={t("auth.totpQrLabel")} />
          <p className="text-xs text-muted-foreground">{t("auth.totpQrHint")}</p>
        </div>
        <a href={enrolment.uri} className={buttonVariants({ variant: "secondary" })}>
          {t("auth.totpOpenApp")}
        </a>
        <Field label={t("auth.totpSecret")} hint={t("auth.totpSecretHint")}>
          {(control) => (
            <div className="flex flex-wrap items-center gap-1">
              <Input
                {...control}
                readOnly
                value={secretOf(enrolment.uri)}
                className="w-auto min-w-0 flex-1 font-mono"
              />
              <CopyButton text={secretOf(enrolment.uri)} label={t("copy.setupKey")} />
            </div>
          )}
        </Field>
        {banner}
        <Field label={t("auth.totpCode")}>
          {(control) => (
            <Input
              {...control}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          )}
        </Field>
        <Button type="submit" disabled={busy}>
          {t("auth.verify")}
        </Button>
      </form>
    </AuthLayout>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <AuthLayout title={t("auth.recoveryTitle")}>
      <div className="flex flex-col gap-4">
        <Banner tone="warning">{t("auth.recoveryWarning")}</Banner>
        <div className="relative rounded-control border border-border bg-surface">
          <ul
            aria-label={t("auth.recoveryTitle")}
            className="grid grid-cols-2 gap-2 p-3 pr-14 font-mono text-sm"
          >
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <CopyButton
            text={codes.join("\n")}
            label={t("copy.recoveryCodes")}
            className="absolute top-1 right-1"
          />
        </div>
        <Button onClick={onDone}>{t("auth.recoverySaved")}</Button>
      </div>
    </AuthLayout>
  );
}

function AddPasskey() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { run, busy, banner } = useAction();
  const finish = () => navigate({ to: "/", replace: true });
  return (
    <AuthLayout title={t("auth.passkeySetupTitle")}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t("auth.passkeySetupIntro")}</p>
        {banner}
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { error: failure } = await authClient.passkey.addPasskey({
                name: t("auth.passkeyDefaultName"),
              });
              if (failure) return authErrorMessage(failure, t, "auth.passkeyFailed");
              await finish();
              return null;
            })
          }
        >
          <KeyRound aria-hidden />
          {t("auth.addPasskey")}
        </Button>
        <Button variant="ghost" onClick={() => void finish()}>
          {t("auth.skipPasskey")}
        </Button>
      </div>
    </AuthLayout>
  );
}

function SetupFlow({ ownerExists, user }: { ownerExists: boolean; user: SessionUser | null }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState<string | undefined>();
  const [codes, setCodes] = useState<string[]>([]);
  const [step, setStep] = useState<Step>(() => {
    if (!ownerExists) return "create";
    return user?.twoFactorEnabled ? "passkey" : "totp";
  });

  if (ownerExists && !user) {
    return (
      <AuthLayout title={t("auth.setupClosedTitle")}>
        <div className="flex flex-col gap-4">
          <Banner tone="info">{t("auth.setupClosed")}</Banner>
          <Link to="/login" className={buttonVariants()}>
            {t("auth.signIn")}
          </Link>
        </div>
      </AuthLayout>
    );
  }
  if (step === "create") {
    return (
      <CreateOwner
        onCreated={(created) => {
          setPassword(created);
          setStep("totp");
        }}
      />
    );
  }
  if (step === "totp") {
    return (
      <EnrollTotp
        initialPassword={password}
        onEnrolled={(recovery) => {
          setCodes(recovery);
          setStep("codes");
        }}
      />
    );
  }
  if (step === "codes") return <RecoveryCodes codes={codes} onDone={() => setStep("passkey")} />;
  return <AddPasskey />;
}

/** First-run screen: owner account (needs the setup token), TOTP enrolment, passkey. */
export function SetupPage() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api<{ ownerExists: boolean }>("/api/setup/status"),
    // A finished setup must not be served from the Query cache.
    staleTime: 0,
    gcTime: 0,
  });
  const session = authClient.useSession();
  const ready = useRef(false);
  if (!status.isPending && !session.isPending) ready.current = true;

  if (status.isError) {
    return (
      <AuthLayout title={t("auth.setupTitle")}>
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={() => void status.refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("common.error")}
        </Banner>
      </AuthLayout>
    );
  }
  // Loading only before the first answers: once the owner is created and the session refetches,
  // unmounting the flow would drop its step and show the create form again.
  if (!ready.current && (status.isPending || session.isPending)) {
    return (
      <AuthLayout title={t("common.loading")}>
        <div role="status" aria-label={t("common.loading")} />
      </AuthLayout>
    );
  }
  return (
    <SetupFlow
      // A signed-in user proves the owner exists even when the cached status is stale.
      ownerExists={Boolean(status.data?.ownerExists || session.data?.user)}
      user={(session.data?.user as SessionUser | undefined) ?? null}
    />
  );
}
