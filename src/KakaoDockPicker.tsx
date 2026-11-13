import { Modal } from "./ui";
import type { DockWindow } from "./types";

export function KakaoDockPicker({
  windows, busy, onSelect, onClose,
}: {
  windows: DockWindow[];
  busy: boolean;
  onSelect: (handle: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="연결할 카카오톡 창 선택" onClose={onClose} busy={busy}>
      <p>연결할 카카오톡 창을 선택하세요. 대화 내용은 읽거나 저장하지 않습니다.</p>
      <div style={{display:"grid",gap:8,maxHeight:"55vh",overflowY:"auto"}}>
        {windows.map((item) => (
          <button
            type="button"
            key={item.handle}
            disabled={busy}
            onClick={() => onSelect(item.handle)}
            style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:4,padding:12}}
          >
            <strong>{item.kind === "MAIN" ? "카카오톡 기본 창" : "카카오톡 대화 창"}</strong>
            <span>{item.title || "(제목 없음)"}</span>
          </button>
        ))}
        {!windows.length && <p>연결할 카카오톡 창이 없습니다.</p>}
      </div>
      <button type="button" disabled={busy} onClick={onClose}>취소</button>
    </Modal>
  );
}
