import {
  applyFactoryReplyPreview, parseFactoryReplyWorkbook,
} from "./factory-reply-workbook";
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
  reason?: string;
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
  try {
    const preview = await parseFactoryReplyWorkbook(current, file);
    if (preview.reply.id !== source.id) {
      throw Error("공장 회신 수신 원본 해시와 검토 결과가 일치하지 않습니다.");
    }
    next = applyFactoryReplyPreview(current, preview).next;
  } catch (error) {
    // A rejected file cannot alter SQLite, receipt history, or shipment data.
    return { duplicate: false, applied: 0, held: 0, invalid: true, reason: String(error) };
  }
  // Native validation and the revision-checked commit run only for valid files.
  const result = await api.factoryReplyWatchCommit(
    source.filename, source.id, next, current.revision ?? 0,
  );
  return { ...result, invalid: false };
}
