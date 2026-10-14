"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";

const schema = z.object({
  email: z.string().trim().email("Enter your work email."),
  password: z.string().min(1, "Enter your password."),
  totp: z.string().optional(),
});
type Values = z.infer<typeof schema>;

/** Messages for the error codes the SSO callback redirects with. */
const SSO_ERRORS: Record<string, string> = {
  sso_unavailable: "That sign-in option isn't set up.",
  sso_cancelled: "Sign-in was cancelled.",
  sso_expired: "Your sign-in took too long or was started in another tab. Please try again.",
  sso_failed: "We couldn't complete the sign-in. Please try again.",
  sso_no_account: "There's no active CRM account for that email address. Ask an administrator to add you.",
  sso_domain: "That email domain can't be used to sign in here.",
  sso_unverified: "Your account didn't share a verified email address.",
};

const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

function SsoButtons({ next }: { next: string }) {
  const providers = useQuery({ queryKey: ["sso-providers"], queryFn: () => api.get<{ id: string; label: string }[]>("/auth/providers"), staleTime: Infinity, retry: false });
  if (!providers.data?.length) return null;
  return (
    <div className="space-y-2">
      {providers.data.map((p) => (
        <Button key={p.id} asChild variant="secondary" className="w-full">
          {/* A full-page navigation: the provider's sign-in page can't be fetched by script. */}
          <a href={`/api/auth/sso/${p.id}/start?next=${encodeURIComponent(next)}`}>Sign in with {p.label}</a>
        </Button>
      ))}
      <div className="flex items-center gap-3 py-1 text-xs text-muted" aria-hidden>
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}

/** Second step after SSO for users who have CRM two-factor authentication on. */
function SsoMfaForm({ next }: { next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ next: string }>("/auth/sso/mfa", { code });
      router.replace(safeNext(r.next ?? next));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't sign in. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="w-full max-w-sm p-6">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm">One more step: enter the code from your authenticator app.</p>
        <Field label="Authenticator code">{(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" loading={busy}>
          Continue
        </Button>
      </form>
    </Card>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(SSO_ERRORS[params.get("error") ?? ""] ?? null);
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await api.post<{ mfaRequired?: boolean; message?: string }>("/auth/login", { email: v.email, password: v.password, totp: v.totp || undefined });
      if (res.mfaRequired) {
        setNeedsCode(true);
        return;
      }
      router.replace(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't sign in. Try again.");
    }
  });

  if (params.get("mfa") === "sso") return <SsoMfaForm next={next} />;

  return (
    <Card className="w-full max-w-sm p-6">
      <div className="mb-4">
        <SsoButtons next={next} />
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" error={formState.errors.email?.message}>
          {(p) => <Input {...p} type="email" autoComplete="username" autoFocus {...register("email")} />}
        </Field>
        <Field label="Password" error={formState.errors.password?.message}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" {...register("password")} />}
        </Field>
        {needsCode && (
          <Field label="Authenticator code" hint="The 6-digit code from your authenticator app.">
            {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus {...register("totp")} />}
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <div className="flex items-center gap-2">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-fg">
          <Zap aria-hidden />
        </span>
        <div>
          <p className="text-lg font-semibold leading-tight">Utility Optimizer</p>
          <p className="text-sm text-muted">CRM</p>
        </div>
      </div>
      <h1 className="sr-only">Sign in</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
