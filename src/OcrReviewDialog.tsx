import { useState } from "react";
import { confirmDiscardDraft } from "./shared/editor-flow";
import { Modal } from "./ui";
import type { OcrCapture } from "./types";

export function OcrReviewDialog({
  result, onCancel, onApply,
}: {
  result: OcrCapture;
  onCancel: () => void;
  onApply: (text: string, mode: "replace" | "append") => void;
}) {
  const [edited, setEdited] = useState(result.text);
  const closeDraft = () => void confirmDiscardDraft("OCR 문자 인식 검토", edited !== result.text, onCancel);
  return (
    <Modal title="OCR 문자 인식 검토" onClose={closeDraft} draft={edited}>
      <p className="muted">
        선택한 화면과 인식 문구를 비교하고 오타를 고쳐 주세요.
        확인 전에는 발주 원문이나 주문 데이터베이스가 변경되지 않습니다.
      </p>
      <img className="ocr-review-preview" src={result.imageDataUrl}
        alt="직접 지정한 캡처 범위 미리보기" />
      <label htmlFor="ocr-review-text">인식된 문구</label>
      <textarea id="ocr-review-text" aria-label="OCR 인식 문구 편집"
        className="ocr-review-textarea" value={edited} maxLength={20000}
        onChange={(event) => setEdited(event.target.value)} />
      <div className="actions ocr-review-actions">
        <button type="button" onClick={closeDraft}>닫기</button>
        <button type="button" disabled={!edited.trim()} onClick={() => onApply(edited, "append")}>
          원문에 추가
        </button>
        <button type="button" className="primary" disabled={!edited.trim()}
          onClick={() => onApply(edited, "replace")}>원문 교체</button>
      </div>
    </Modal>
  );
}
