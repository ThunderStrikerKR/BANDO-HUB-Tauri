import { type CSSProperties, type ReactNode } from "react";
import { useViewportScale } from "./shared/useViewportScale";
export const defaultPanels = [20, 80 / 3, 80 / 3, 80 / 3];
export function validPanels(value: unknown): number[] {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    ? value
    : defaultPanels;
}
export function HubPanels({
  children,
  externalKakao = false,
  ratios,
}: {
  children: ReactNode[];
  externalKakao?: boolean;
  ratios: number[];
  onSave: (r: number[]) => void;
  onReset: () => void;
}) {
  const viewportScale = useViewportScale(),
    minima = [200, 250, 250, 250].map((value) => value * viewportScale);
  const shown = externalKakao ? [1, 2, 3] : [0, 1, 2, 3],
    r = [validPanels(ratios)[0], 1, 1, 1],
    total = shown.reduce((sum, i) => sum + r[i], 0),
    minWidth = shown.reduce((sum, i) => sum + minima[i], 0) + (shown.length - 1) * 6;
  return (
    <div className="hub-workspace-scroll">
      <div
        className="hub-panels"
        style={
          {
            minWidth,
            gridTemplateColumns: shown
              .flatMap((i, index) => [
                `minmax(${minima[i]}px,${r[i] / total}fr)`,
                ...(index < shown.length - 1 ? ["6px"] : []),
              ])
              .join(" "),
          } as CSSProperties
        }
      >
        {shown.flatMap((i, index) => [
          <div className={"hub-panel-slot hub-slot-" + i} key={"panel" + i}>
            {children[i]}
          </div>,
          ...(index < shown.length - 1
            ? [
                <div
                  key={"split" + i}
                  role="separator"
                  aria-label="업무 열 구분"
                  aria-orientation="vertical"
                  className="hub-split"
                  title="업무 열은 동일한 너비로 유지됩니다."
                />,
              ]
            : []),
        ])}
      </div>
    </div>
  );
}
