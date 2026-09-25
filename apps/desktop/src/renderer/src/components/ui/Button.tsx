import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-indigo-500 text-white hover:bg-indigo-400 focus-visible:ring-indigo-400/40 shadow-sm shadow-indigo-950/40",
  secondary:
    "bg-slate-800 text-slate-100 hover:bg-slate-700 focus-visible:ring-slate-600/40 border border-slate-700",
  ghost: "text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:ring-slate-600/40",
  danger: "bg-rose-600/90 text-white hover:bg-rose-500 focus-visible:ring-rose-400/40",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-11 px-5 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }): JSX.Element {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" className="stroke-current opacity-20" strokeWidth="4" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        className="stroke-current"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}