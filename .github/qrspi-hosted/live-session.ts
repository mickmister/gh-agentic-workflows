import { basename } from "node:path";
import { NativeCapture } from "./native-capture.ts";
import { assert } from "./core.ts";
import { digest, type PrivateStore } from "./storage.ts";
import type { ExecutionEvidence } from "./execution.ts";
import type { SessionIdentity } from "./session.ts";

/** Trusted parent tails existing stdout spools. No storage credential reaches Pi. */
export function observePi(dir: string, evidence: ExecutionEvidence, session: SessionIdentity, failed: (error: unknown) => void) {
  const capture = new NativeCapture(dir, (event, path) => {
    assert(event && typeof event === "object" && typeof (event as any).type === "string", "Invalid Pi stdout event");
    evidence.event("pi", evidence.scope(session), { source: basename(path), event });
  }, () => evidence.flush(), /^(pi|resume|phase|worker)-events\.log$/);
  let chain = Promise.resolve(), failure: unknown;
  const poll = () => { chain = chain.then(async () => { if (!failure) await capture.collect(); }).catch(error => { failure ??= error; failed(error); }); };
  const timer = setInterval(poll, 1000); timer.unref();
  return async () => { clearInterval(timer); poll(); await chain; if (failure) throw failure; capture.assertComplete(); };
}

/** Immutable selected-workspace inventory, distinct from authored Documents. */
export async function announceLive(store: Pick<PrivateStore, "prefix" | "put">, evidence: ExecutionEvidence, command: string, env = process.env) {
  const repository = env.GITHUB_REPOSITORY!, storageRepository = env.REVIEW_REPOSITORY!;
  assert([repository, storageRepository].every(value => /^[\w.-]+\/[\w.-]+$/.test(value)), "Invalid live repository identity");
  assert(/^[1-9]\d{0,15}-[1-9]\d{0,15}$/.test(evidence.executionId) && ["open", "work"].includes(command), "Invalid live invocation identity");
  assert(/^[\w-]{1,200}$/.test(evidence.binding.workspace) && /^ws-[a-f0-9]{32}$/.test(evidence.binding.workspace_ref), "Invalid live workspace identity");
  assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""), "Invalid live source SHA");
  const relative = `processes/${digest(evidence.binding)}/executions/${evidence.executionId}/${command}/`;
  const locator = { kind: "pi-live-locator", schemaVersion: 1, binding: evidence.binding, storageRepository,
    repository, executionId: evidence.executionId, command, sourceSha: env.GITHUB_SHA, piVersion: "1.5.2",
    createdAt: new Date().toISOString(), evidencePrefix: store.prefix + relative };
  await store.put(`live/${storageRepository.toLowerCase()}/${evidence.binding.workspace}/${evidence.executionId}/${command}.json`, locator, { create: true });
  return async (status: "completed" | "failed") => {
    await evidence.close();
    const usage = evidence.usage();
    await store.put(`${relative}terminal.json`, { kind: "pi-live-terminal", schemaVersion: 1, binding: evidence.binding,
      executionId: evidence.executionId, command, status, chunks: usage.chunks, sequence: usage.events,
      finishedAt: new Date().toISOString(), phaseApproval: false }, { create: true });
  };
}
