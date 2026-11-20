import { assert } from "./core.ts";

/** Zero means no elapsed-work deadline. Startup and cleanup have their own clocks. */
export function turnTimeout(value = 0) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= 2_147_478_647, "Invalid session deadline");
  return value;
}

export async function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  // Observe the task even when authority has already been withdrawn.
  void task.catch(() => {});
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("Turn cancelled"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
