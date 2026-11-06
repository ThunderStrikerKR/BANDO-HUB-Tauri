import type { Client, DockWindow, State } from "./types.js";
export const titleKey = (s: string) =>
  s.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
export function titleCandidates(title: string, clients: Client[]) {
  const key = titleKey(title).replace(/\s/g, "");
  if (!key) return [];
  return clients.filter(
    (c) =>
      !c.deletedAt &&
      [c.name, c.displayName, c.shortNames, c.identifiers].filter(Boolean).some((v) =>
        String(v)
          .split(/[,;|\n]/)
          .some((term) => {
            const t = titleKey(term).replace(/\s/g, "");
            return t.length >= 2 && (t === key || key.includes(t));
          }),
      ),
  );
}
export function rememberedTitleClient(state: State, windows: DockWindow[]) {
  const chats = windows.filter((w) => w.kind === "CHAT"),
    eligible = chats
      .filter((w) => chats.filter((x) => titleKey(x.title) === titleKey(w.title)).length === 1)
      .map((w) => ({
        w,
        m: state.settings.kakaoTitleMappings?.[titleKey(w.title)],
      }))
      .filter(
        (x) =>
          x.m &&
          !x.m.ambiguous &&
          state.clients.some((c) => c.id === x.m?.clientId && !c.deletedAt && c.active !== false),
      );
  return chats.length === 1 && eligible.length === 1 ? eligible[0].m!.clientId : undefined;
}
export function rememberTitle(
  state: State,
  windows: DockWindow[],
  handle: string,
  clientId: string,
  actor: string,
) {
  const next = structuredClone(state),
    w = windows.find((w) => w.kind === "CHAT" && w.handle === handle);
  if (!w || !next.clients.some((c) => c.id === clientId && !c.deletedAt))
    throw Error("현재 대화창과 거래처를 선택하세요.");
  const key = titleKey(w.title),
    duplicate = windows.filter((x) => x.kind === "CHAT" && titleKey(x.title) === key).length > 1;
  next.settings.kakaoTitleMappings = {
    ...next.settings.kakaoTitleMappings,
    [key]: {
      clientId,
      updatedAt: new Date().toISOString(),
      actor,
      ambiguous: duplicate,
    },
  };
  return next;
}
