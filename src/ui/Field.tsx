import type { ReactNode } from "react";
import { HelpTooltip, type HelpTooltipText } from "./HelpTooltip";
import { Children, cloneElement, createContext, isValidElement, useContext, useId } from "react";
const FieldContext = createContext<{ id: string; label: string } | undefined>(undefined);
export function useField() {
  return useContext(FieldContext);
}
export function Field({ label, children, help }: { label: string; children: ReactNode; help?: HelpTooltipText }) {
  const id = useId();
  const native = Children.toArray(children).find(
    (child) =>
      isValidElement(child) &&
      typeof child.type === "string" &&
      ["input", "select", "textarea"].includes(child.type),
  );
  const target = isValidElement<{ id?: string }>(native) ? (native.props.id ?? id) : id;
  return (
    <FieldContext.Provider value={{ id: target, label }}>
      <div className="field">
        <div className="field-label-wrap">
          <label className="field-label" htmlFor={target}>{label}</label>
          {help && <HelpTooltip title={label} {...help} />}
        </div>
        {Children.map(children, (child) =>
          isValidElement<{ "aria-label"?: string; id?: string }>(child) &&
          typeof child.type === "string" &&
          ["input", "select", "textarea"].includes(child.type)
            ? cloneElement(child, {
                id: child.props.id ?? target,
                "aria-label": child.props["aria-label"] ?? label,
              })
            : child,
        )}
      </div>
    </FieldContext.Provider>
  );
}
