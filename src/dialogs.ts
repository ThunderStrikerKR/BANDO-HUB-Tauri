import { pauseModalLayer } from "./ui";
let pending = false;
function ask(
  message: string,
  value?: string,
  labels?: { cancel: string; accept: string },
): Promise<string | null> {
  if (pending) return Promise.resolve(null);
  pending = true;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const resumeModal = pauseModalLayer();
  const dialog = document.createElement("dialog");
  dialog.className = "app-action-dialog";
  dialog.setAttribute("aria-label", value === undefined ? "작업 확인" : "값 입력");
  const form = document.createElement("form"),
    title = document.createElement("h2"),
    description = document.createElement("p"),
    actions = document.createElement("div"),
    cancel = document.createElement("button"),
    accept = document.createElement("button");
  title.textContent = value === undefined ? "확인해 주세요" : "값을 입력해 주세요";
  description.textContent = message;
  actions.className = "dialog-actions";
  cancel.type = "button";
  cancel.textContent = labels?.cancel ?? "취소";
  accept.type = "submit";
  accept.textContent = labels?.accept ?? "확인";
  accept.className = "primary";
  form.append(title, description);
  let input: HTMLInputElement | undefined;
  if (value !== undefined) {
    input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute("aria-label", message);
    form.append(input);
  }
  actions.append(cancel, accept);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let done = false;
    const finish = (accepted: boolean) => {
      if (done) return;
      done = true;
      const result = accepted ? (input?.value ?? "ok") : null;
      dialog.close();
      dialog.remove();
      pending = false;
      resumeModal();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(result);
    };
    cancel.onclick = () => finish(false);
    form.onsubmit = (e) => {
      e.preventDefault();
      finish(true);
    };
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    dialog.onclose = () => {
      if (!done) finish(false);
    };
    try {
      dialog.showModal();
      if (input) {
        input.focus();
        input.select();
      } else cancel.focus();
    } catch {
      finish(false);
    }
  });
}
export async function confirmAction(message: string, labels?: { cancel: string; accept: string }) {
  return (await ask(message, undefined, labels)) !== null;
}
export function promptText(message: string, initial = "") {
  return ask(message, initial);
}

/**
 * Three-choice confirmation for leaving an order with unsaved manual edits.
 * Closing the dialog or pressing Escape always keeps the user on the editor.
 */
export type SaveChangesChoice = "save" | "discard" | "cancel";
export function askSaveChanges(message = "변경사항이 저장되지 않았습니다. 어떻게 할까요?"): Promise<SaveChangesChoice> {
  if (pending) return Promise.resolve("cancel");
  pending = true;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const resumeModal = pauseModalLayer();
  const dialog = document.createElement("dialog");
  dialog.className = "app-action-dialog";
  dialog.setAttribute("aria-label", "변경사항 저장");
  const form = document.createElement("form");
  const heading = document.createElement("h2");
  heading.textContent = "변경사항 저장";
  const description = document.createElement("p");
  description.textContent = message;
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  const discard = document.createElement("button");
  const save = document.createElement("button");
  cancel.type = discard.type = save.type = "button";
  cancel.textContent = "취소";
  discard.textContent = "저장 안 함";
  save.textContent = "저장";
  save.className = "primary";
  actions.append(cancel, discard, save);
  form.append(heading, description, actions);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let complete = false;
    const finish = (choice: SaveChangesChoice) => {
      if (complete) return;
      complete = true;
      dialog.close();
      dialog.remove();
      pending = false;
      resumeModal();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(choice);
    };
    cancel.onclick = () => finish("cancel");
    discard.onclick = () => finish("discard");
    save.onclick = () => finish("save");
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish("cancel");
    };
    dialog.onclose = () => {
      if (!complete) finish("cancel");
    };
    try {
      dialog.showModal();
      cancel.focus();
    } catch {
      finish("cancel");
    }
  });
}
