import type { ButtonHTMLAttributes } from "react";
export function Button({
  variant = "secondary",
  size = "normal",
  busy = false,
  className = "",
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
  size?: "normal" | "compact";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`ui-button ui-button-${variant} ui-button-${size} ${variant === "primary" ? "primary" : variant === "danger" ? "danger" : ""} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? "처리 중…" : children}
    </button>
  );
}
