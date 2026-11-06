export type NoticeTone = "success" | "error" | "info";
export type NoticeSink = (message: string, tone?: NoticeTone) => void;
export interface Notice {
  message: string;
  tone: NoticeTone;
  id: number;
  anchor?: HTMLElement;
}
