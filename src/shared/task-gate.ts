import { readableError } from "../errors";
export type TaskResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "busy" | "error"; message?: string };
/** One operation per owner, including two calls made before React can render. */
export function createTaskGate() {
  let running = false;
  return {
    get busy() {
      return running;
    },
    async run<T>(action: () => T | Promise<T>): Promise<TaskResult<T>> {
      if (running) return { ok: false, reason: "busy" };
      running = true;
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        return { ok: false, reason: "error", message: readableError(error) };
      } finally {
        running = false;
      }
    },
  };
}
