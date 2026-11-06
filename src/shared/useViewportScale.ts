import { useLayoutEffect, useState } from "react";

/** Keep panel minima usable when browser zoom reduces the available CSS viewport. */
export function useViewportScale() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return Math.min(1, width / 1280);
}
