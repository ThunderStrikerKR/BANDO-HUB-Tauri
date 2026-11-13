import type { ReactNode } from "react";
export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading manager-bar">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  children,
  compact = false,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty-state empty-state-compact" : "empty-state"} role="status">
      <p>{title}</p>
      {description && <small>{description}</small>}
      {children}
    </div>
  );
}
