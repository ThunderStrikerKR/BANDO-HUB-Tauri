import { useRef, useState } from "react";
import { useNativeClients } from "./native-catalog-queries";
import { readableError } from "./errors";
import { TierBadge } from "./ManagementUI";
import type { Client } from "./types";
import { Modal } from "./ui";
export function ClientChooser({
  clients,
  current,
  onSelect,
  onClose,
}: {
  clients: Client[];
  current?: Client;
  onSelect: (c: Client) => Promise<void> | void;
  onClose: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const {results: matches, error: searchError, pending} = useNativeClients(clients, query);
  const rows = query.trim() ? matches : clients.filter((c) => !c.deletedAt);
  return (
    <Modal
      title="거래처 변경"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="client-chooser">
        <p>
          현재 거래처:{" "}
          {current ? (
            <>
              <b>{current.name}</b> <TierBadge client={current} />
            </>
          ) : (
            "미선택"
          )}
        </p>
        <input
          ref={search}
          autoFocus
          aria-label="거래처 변경 검색"
          placeholder="상호 / 별칭 / 주소 / 전화번호 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(error || searchError) && (
          <p role="alert" className="warnings">
            {error || searchError}
          </p>
        )}
        <small>{pending && query.trim() ? "검색 중" : rows.length + "개 거래처"}</small>
        <div className="client-chooser-list">
          {rows.map((c) => (
            <button
              className="client-result"
              key={c.id}
              disabled={busy}
              aria-current={current?.id === c.id ? "true" : undefined}
              onClick={async () => {
                if (c.id === current?.id) {
                  onClose();
                  return;
                }
                setBusy(true);
                setError("");
                try {
                  await onSelect(c);
                  onClose();
                } catch (e) {
                  setError(readableError(e));
                } finally {
                  setBusy(false);
                  requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
                }
              }}
            >
              <span>
                <b>
                  {c.name}
                  {current?.id === c.id ? " / 현재 거래처" : ""}
                </b>
                <small>
                  {c.address || "주소 미등록"} / {c.phone || c.mobile || "전화 미등록"}
                </small>
              </span>
              <TierBadge client={c} />
            </button>
          ))}
          {!rows.length && <p>검색 결과가 없습니다.</p>}
        </div>
      </div>
    </Modal>
  );
}
