import { assert } from "./core.ts";
import { digest } from "./storage.ts";
import { GitHub } from "./github.ts";
import { developmentThread, type DevelopmentBinding } from "./development-context.ts";

/** Compact observed progress only. Native evidence remains private S3. This
 * projection confers no approval and does not schedule, retry or cancel work.
 */
export function developmentStatus(binding: DevelopmentBinding, executionId: string,
  read: (name: string) => Promise<any>, save: (name: string, value: unknown) => Promise<unknown>, env = process.env, transport: typeof fetch = fetch) {
  let receipt: any, unavailable = false;
  const github = new GitHub(env, transport), repository = env.GITHUB_REPOSITORY!, sha = env.GITHUB_SHA!;
  const external = `pi-development:${digest([binding.workspace, developmentThread(binding), binding.process, executionId])}`;
  const api = (path: string, method = "GET", body?: unknown) => github.api(`/repos/${repository}${path}`, env.GITHUB_TOKEN!, method, body);
  return async (progress: { currentStep: string; nextStep: string; cycle: number; roles?: unknown[] }, extra: { delivery?: string; analysis?: string; reviewUrl?: string } = {}, terminal = false) => {
    if (unavailable || !env.GITHUB_TOKEN) return;
    try {
      if (!receipt) {
        receipt = await read("status-check/receipt.json");
        if (!receipt) {
          const prior = await read("status-check/intent.json");
          const intent = { repository, sha, external, executionId };
          if (prior) assert(digest(prior) === digest(intent), "Progress check binding changed");
          else {
            await save("status-check/intent.json", intent);
            try { await api("/check-runs", "POST", { name: `Development ${binding.process}`, head_sha: sha, external_id: external, status: "in_progress" }); } catch {}
          }
          const matches: any[] = [];
          for (let page = 1; page <= 10; page++) {
            const listing = await api(`/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`);
            assert(Array.isArray(listing.check_runs), "Missing check inventory");
            matches.push(...listing.check_runs.filter((check: any) => check.external_id === external && check.head_sha === sha && check.app?.slug === "github-actions"));
            if (listing.check_runs.length < 100) break;
            assert(page < 10, "Progress check inventory incomplete");
          }
          assert(matches.length === 1 && Number.isSafeInteger(matches[0].id), "Progress check creation unconfirmed; do not repeat");
          receipt = { ...intent, id: matches[0].id }; await save("status-check/receipt.json", receipt);
        }
        assert(receipt.repository === repository && receipt.sha === sha && receipt.external === external && receipt.executionId === executionId, "Progress receipt mismatch");
      }
      const value = { schemaVersion: 1, workspace: binding.workspace, thread: developmentThread(binding), process: binding.process, executionId,
        updatedAt: new Date().toISOString(), currentStep: progress.currentStep, nextStep: progress.nextStep, cycle: progress.cycle, maxCycles: 4,
        roles: progress.roles ?? [], delivery: extra.delivery ?? "pending", analysis: extra.analysis ?? "pending", ...(extra.reviewUrl ? { reviewUrl: extra.reviewUrl } : {}) };
      const update = { status: terminal ? "completed" : "in_progress", ...(terminal ? { conclusion: "neutral" } : {}),
        output: { title: progress.currentStep, summary: "Observed workflow progress; not candidate, human or QRSPI approval.", text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` } };
      await save(`status-check/updates/${digest(update)}.json`, { checkId: receipt.id, update });
      await api(`/check-runs/${receipt.id}`, "PATCH", update);
    } catch {
      // Observability availability must not erase delivery or authorize replay.
      // Retained create intent prevents a second check creation after uncertainty.
      unavailable = true;
    }
  };
}
