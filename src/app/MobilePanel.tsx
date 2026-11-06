import { useState } from "react";
import type { NoticeSink } from "../shared/notices";
import { useAsyncTask } from "../shared/useAsyncTask";
import type { InboxEntry, MobileStatus } from "../types";
export function MobilePanel({
  onNotice,
  onReceive,
}: {
  onNotice: NoticeSink;
  onReceive: (e: InboxEntry) => Promise<void>;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [status, setStatus] = useState<MobileStatus>(),
    [entries, setEntries] = useState<InboxEntry[]>([]);
  return (
    <details className="card">
      <summary>휴대폰 주문 수신</summary>
      <button
        disabled={busy}
        onClick={() => void run(async () => setStatus(await window.bando!.mobileStart()))}
      >
        수신 시작
      </button>
      <button
        disabled={busy}
        onClick={() => void run(async () => setStatus(await window.bando!.mobileStop()))}
      >
        중지
      </button>
      <button
        disabled={busy}
        onClick={() => void run(async () => setEntries(await window.bando!.inbox()))}
      >
        수신 목록 새로고침
      </button>
      {status?.urls.map((u) => (
        <p className="mobile-url" key={u}>
          {u}
        </p>
      ))}
      {entries.map((e) => (
        <article className="inbox-entry" key={e.id}>
          <p>{e.text}</p>
          {e.photo && <img src={e.photo} alt="수신 사진" width="150" />}
          <button disabled={busy} onClick={() => void run(() => onReceive(e))}>
            주문으로 열기
          </button>
        </article>
      ))}
    </details>
  );
}
