import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { join } from "node:path";
import { assert, type Binding } from "./core.ts";
import { digest, type PrivateStore } from "./storage.ts";
import type { GitHub } from "./github.ts";
import { completedDrafts } from "./workspace-publication.ts";
import { assertSpecKitCheckpoint } from "./workspace-host.ts";

export async function recoverPublication(env: NodeJS.ProcessEnv, store: PrivateStore, github: GitHub, binding: Binding, key: string, home: string) {
  const target = env.RECOVER_PUBLICATION!;
  assert(/^[1-9][0-9]{0,19}$/.test(target) && target !== env.GITHUB_RUN_ID && env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.QRSPI_REVIEWERS?.split(",").map(v => v.trim()).includes(`github:${env.GITHUB_ACTOR_ID}`), "Publication recovery requires an authorized direct operator and exact old run");
  const active = await store.read(`${key}/active-invocation.json`), checkpoint = await store.read(`${key}/checkpoint.json`);
  assert(active?.value.run === target && active.value.outcome === "admitted-uncertain" && digest(active.value.binding) === digest(binding), "Publication recovery active invocation mismatch");
  const prior = checkpoint?.value;
   assert(prior, "Publication recovery requires an existing checkpoint");
   assertSpecKitCheckpoint(prior);
   assert(digest(prior.binding) === digest(binding) && prior.sourceAuthority === false && !prior.tasks.length, "Publication recovery only supports source-disabled Spec Kit discussion with an existing checkpoint");
  const run = await github.api(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${target}`, await github.token(env.GITHUB_REPOSITORY!, "inspect"));
  assert(run.status === "completed" && run.conclusion === "failure" && run.run_attempt === 1 && run.path === ".github/workflows/qrspi-process.yml", "Publication recovery requires the exact failed first attempt");
  const error = await store.read(`${key}/private/error-${target}-1-work.json`);
  assert(error?.value.message === "Invalid checkpoint members", "Publication recovery requires the known pre-publication membership failure");
  const original = await store.read(active.value.admission);
  assert(original?.value.run === target && original.value.outcome === "admitted-uncertain" && !original.value.receipt && digest(original.value.binding) === digest(binding), "Original discussion admission mismatch");
  const prepared = await store.read(`${key}/private/prepared-${target}-1.json`);
  assert(digest(prepared?.value.binding) === digest(binding) && prepared?.value.setup?.setup === null &&
    digest(prepared.value.members) === digest(prior.members), "Prepared source vector/setup mismatch");
  const prefix = `${key}/private/${target}-1-session-`;
  const listed = await store.client.send(new ListObjectsV2Command({ Bucket: store.bucket, Prefix: store.prefix + prefix, MaxKeys: 32 }));
  assert(!listed.IsTruncated && listed.Contents && listed.Contents.length <= 12, "Native archive listing incomplete");
  const parents = [];
  for (const item of listed.Contents) {
    assert(typeof item.Key === "string" && item.Key.startsWith(store.prefix + prefix) && /^[a-f0-9-]{36}\.json$/.test(item.Key.slice((store.prefix + prefix).length)), "Native archive escaped recovery target");
    const record = await store.read(item.Key.slice(store.prefix.length));
    if (record?.value.session?.role === "orchestrator" && record.value.session.parentId === null) parents.push(record.value);
  }
  assert(parents.length === 1 && parents[0].session.executionId === `${target}-1` && parents[0].session.sourceSha === run.head_sha, "Missing or ambiguous original parent session");
  const recovered = completedDrafts(parents[0], prior.artifacts);
  const admission = `${key}/admissions/${digest({ publicationRecovery: target, run: env.GITHUB_RUN_ID })}.json`;
  assert(await store.admit(admission, { binding, run: env.GITHUB_RUN_ID, outcome: "admitted-uncertain", recoveredModelRun: target }), "Publication recovery admission conflict");
  await store.put(`${key}/publication-recoveries/${target}.json`, { binding, originalAdmission: active.value.admission,
    recoveryRun: env.GITHUB_RUN_ID, recoveredModelSession: parents[0].session.id, originalAdmissionRetained: true }, { create: true });
  await store.put(`${key}/active-invocation.json`, { binding, admission, run: env.GITHUB_RUN_ID, outcome: "admitted-uncertain" }, { etag: active.etag });
  return { prior, etag: checkpoint!.etag, root: join(home, "workspace"), members: prior.members, manifest: prior.manifest,
    tasks: [], sourceAuthority: false, artifacts: recovered.artifacts, pins: { ...prior.pins }, admission,
    recoveredResult: recovered.result, recoveredModelRun: target,
    setup: { selection: null, required: false, reason: prepared.value.setup.reason, outcome: "success" } };
}
