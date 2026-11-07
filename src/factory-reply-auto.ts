import {
  applyFactoryReplyPreview, parseFactoryReplyWorkbook,
} from "./factory-reply-workbook";
import type { FactoryReply } from "./factory-replies";
import type { Api, State } from "./types";

export interface WatchedReplyFile {
  filename: string;
  id: string;
  bytes: number[];
}
export interface WatchedReplyResult {
  duplicate: boolean;
  applied: number;
  held: number;
  archiveWarning?: string | null;
}

export interface AutoReplyOutcome extends WatchedReplyResult {
  invalid: boolean;
}

/** Reuse the existing manual XLSX parser and row-matching policy.
 * Rust independently checks that the original folder bytes still match the
 * SHA-256 ID, then guards the final DB commit against unrelated state writes.
 */
export async function processWatchedFactoryReply(
  api: Pick<Api, "load" | "factoryReplyWatchCommit">, source: WatchedReplyFile,
): Promise<AutoReplyOutcome> {
  if (!api.factoryReplyWatchCommit) {
    throw Error("자동 공장 회신 저장 기능을 사용할 수 없습니다.");
  }
  const current = await api.load();
  if (current.factoryReplies?.some((record) => record.id === source.id)) {
    return { duplicate: true, applied: 0, held: 0, invalid: false };
  }
  const file = new File(
    [new Uint8Array(source.bytes) as BlobPart],
    source.filename,
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  );
  let next: State;
  let invalid = false;
  try {
    const preview = await parseFactoryReplyWorkbook(current, file);
    if (preview.reply.id !== source.id) {
      throw Error("공장 회신 수신 원본 해시와 검토 결과가 일치하지 않습니다.");
    }
    next = applyFactoryReplyPreview(current, preview).next;
  } catch (error) {
    // An invalid file does not silently disappear and cannot change any
    // shipment. Save a REVIEW record with the original file for human audit.
    invalid = true;
    const report: FactoryReply = {
      id: source.id,
      filename: source.filename,
      businessDate: new Date().toLocaleDateString("sv-SE"),
      at: new Date().toISOString(),
      actor: current.settings.operatorName?.trim() || "자동 감시",
      status: "REVIEW",
      error: "Excel 양식 검증 실패: " + String(error).slice(0, 340),
      rows: [],
    };
    next = structuredClone(current);
    next.factoryReplies = [...(current.factoryReplies ?? []), report];
  }
  const result = await api.factoryReplyWatchCommit(
    source.filename, source.id, next, current.revision ?? 0,
  );
  return { ...result, invalid };
}
