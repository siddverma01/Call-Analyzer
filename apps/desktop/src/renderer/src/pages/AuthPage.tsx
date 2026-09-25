import { useState } from "react";
import type { JSX } from "react";
import { useAuthStore } from "../stores/authStore";
import { Button } from "../components/ui/Button";
import { ErrorNote, Field, Input } from "../components/ui/inputs";
import { IconEye, IconEyeOff, IconMic } from "../components/ui/Icons";

type Mode = "login" | "register";

export function AuthPage(): JSX.Element {
  const phase = useAuthStore((s) => s.phase);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const clearError = useAuthStore((s) => s.clearError);

  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const expired = phase === "expired";

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    clearError();
    if (mode === "login") {
      await login(email.trim(), password);
    } else {
      await register(name.trim(), email.trim(), password);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-indigo-950/50 [background:linear-gradient(135deg,var(--accent-from),var(--accent-to))]">
            <IconMic className="text-2xl" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-white">CallNotes AI</h1>
          <p className="mt-1 text-sm text-slate-400">Transcribe meetings privately and on-device.</p>
        </div>

        {expired && (
          <div className="mb-4 rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
            Your session expired. Sign in again to continue.
          </div>
        )}

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-slate-800/60 p-1">
            {(["login", "register"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  clearError();
                }}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  mode === m ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            {mode === "register" && (
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                  required
                  maxLength={120}
                />
              </Field>
            )}
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                maxLength={254}
              />
            </Field>
            <Field label="Password" hint={mode === "register" ? "At least 10 characters." : undefined}>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "register" ? "Choose a strong password" : "Your password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  required
                  minLength={mode === "register" ? 10 : 1}
                  maxLength={128}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </Field>

            {error && <ErrorNote message={error} />}

            <Button type="submit" loading={busy} className="w-full" size="lg">
              {mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-slate-600">
          Your sessions are stored locally and encrypted at rest by your operating system.
        </p>
      </div>
    </div>
  );
}