import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { validPanels } from "./HubPanels";
import type { DockStatus } from "./types";
import { useViewportScale } from "./shared/useViewportScale";
export function HubShell({
  children,
  ratios,
  dock,
  busy,
  onConnect,
  onSave,
  onReset,
}: {
  children: ReactNode;
  ratios: number[];
  dock: DockStatus;
  busy: boolean;
  onConnect: () => void;
  onSave: (r: number[]) => void;
  onReset: () => void;
}) {
  const viewportScale = useViewportScale(),
    kakaoMinimum = 392 * viewportScale,
    mainMinimum = 832 * viewportScale;
  const [live, setLive] = useState<number[]>(),
    region = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; width: number; r: number[] } | undefined>(undefined);
  const r = live ?? validPanels(ratios),
    total = r.reduce((a, b) => a + b, 0),
    stacked = dock.active && dock.mode === "STACK";
  useLayoutEffect(() => {
    const el = region.current;
    if (!el) return;
    let frame = 0;
    const send = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const b = el.getBoundingClientRect();
        document.documentElement.style.setProperty(
          "--kakao-reserved-width", stacked ? "0px" : b.right + 6 + "px",
        );
        void window.bando
          ?.dockRegion({ x: b.x, y: b.y, width: b.width, height: b.height })
          .catch(() => {});
      });
    };
    const observer = new ResizeObserver(send);
    observer.observe(el);
    window.addEventListener("resize", send);
    send();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [stacked]);
  return (
    <div className="hub-shell-scroll">
      <div
        className="hub-shell"
        style={{
          minWidth: stacked ? "1024px" : undefined,
          gridTemplateColumns: stacked
            ? "minmax(1024px, 1fr)"
            : `minmax(${kakaoMinimum}px,${r[0]}fr) 6px minmax(${mainMinimum}px,${total - r[0]}fr)`,
        }}
      >
        <aside className="hub-panel-slot hub-slot-0 hub-kakao-slot" hidden={stacked}>
          <div ref={region} className="kakao-native-region">
            {!dock.active && (
              <button className="kakao-connect" disabled={busy} onClick={onConnect}>
                {busy ? "연결 중…" : "카카오톡 연결"}
              </button>
            )}
          </div>
        </aside>
        <div
          className="hub-split"
          hidden={stacked}
          role="separator"
          tabIndex={0}
          aria-label="패널 너비 조절 1"
          aria-orientation="vertical"
          title="드래그하여 카카오톡 너비 조절 / 두 번 클릭 기본 배치"
          onDoubleClick={() => {
            setLive(undefined);
            onReset();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setLive(undefined);
              onReset();
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = {
              x: e.clientX,
              width: e.currentTarget.parentElement!.getBoundingClientRect().width - 6,
              r: r.slice(),
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const sum = d.r.reduce((a, b) => a + b, 0),
              left = Math.max(
                kakaoMinimum,
                Math.min(d.width - mainMinimum, (d.r[0] / sum) * d.width + e.clientX - d.x),
              ),
              first = (left / d.width) * sum,
              rest = sum - d.r[0];
            setLive([first, ...d.r.slice(1).map((n) => (n / rest) * (sum - first))]);
          }}
          onPointerUp={() => {
            if (!drag.current) return;
            const previous = drag.current.r;
            drag.current = undefined;
            if (live && JSON.stringify(live) !== JSON.stringify(previous)) onSave(live);
            setLive(undefined);
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setLive(undefined);
          }}
        />
        <div className="hub-main-content">{children}</div>
      </div>
    </div>
  );
}
