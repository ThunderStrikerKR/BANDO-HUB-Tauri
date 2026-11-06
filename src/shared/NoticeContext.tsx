import { createContext, useContext } from "react";
import type { NoticeSink } from "./notices";
export const NoticeContext = createContext<NoticeSink>((message) => console.error(message));
export function useNoticeSink() {
  return useContext(NoticeContext);
}
