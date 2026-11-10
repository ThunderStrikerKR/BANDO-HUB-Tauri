import type { TableHTMLAttributes } from "react";

/**
 * Presentational table for management screens. Keeps native table semantics
 * and delegates all row, column, sorting and action behavior to the caller.
 */
export function ManagementTable({
  className = "",
  children,
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table {...props} className={["management-data-table", className].filter(Boolean).join(" ")}>
      {children}
    </table>
  );
}
