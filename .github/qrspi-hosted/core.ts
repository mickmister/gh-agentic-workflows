import { parse, stringify } from "yaml";
export type Pin = {
  resource: string;
  version_kind: "git-blob";
  version: string;
  snapshot: string;
};
export type Receipt = {
  resource: string;
  version: string;
  snapshot: string;
  reviewer: string;
};
export type Binding = {
  workspace: string;
  workspace_ref: string;
  process: string;
  bead: string;
};
export type Awaited = {
  request: Pin;
  config: Pin;
  artifact: Pin;
  form: Pin;
  artifactName: string;
  requestId: string;
  approvalOffered: boolean;
  // Distinct informed choice for an unverified round, never an unresolved-finding waiver.
  approvalChoice?: "approve" | "approve-unverified";
};
export type Checkpoint = {
  binding: Binding;
  artifacts: Record<string, string>;
  pins: Record<string, Pin>;
  awaiting: Awaited;
  setup?: unknown;
};
export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function validateSeed(seed: any) {
  assert(
    seed &&
      Object.keys(seed).sort().join(",") ===
        "collection_id,dolt_commit,engagement,schema_version,workspace,workspace_ref",
    "Invalid native handoff fields",
  );
  assert(
    seed.schema_version === 1 && /^ws-[a-f0-9]{32}$/.test(seed.workspace_ref),
    "Invalid native stable workspace identity",
  );
  assert(
    typeof seed.engagement === "string" &&
      seed.engagement.length > 0 &&
      seed.engagement.length <= 200 &&
      typeof seed.collection_id === "string" &&
      seed.collection_id.length > 0 &&
      seed.collection_id.length <= 200,
    "Invalid native engagement/collection",
  );
  assert(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(seed.workspace) &&
      /^[0-9a-v]{32}$/.test(seed.dolt_commit),
    "Invalid native workspace/checkpoint",
  );
  return seed;
}
export function admissionIdentity(receipt?: Receipt) {
  if (!receipt) return { start: true };
  const match =
    /^(review-requests\/[A-Za-z0-9][A-Za-z0-9_-]{0,159})\/responses\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.json$/.exec(
      receipt.resource,
    );
  assert(match, "Invalid response receipt path");
  // One admission for the awaited request, not for each retry envelope, snapshot,
  // reviewer or response ID. An uncertain response can never be bypassed by a
  // second submission for the same gate.
  return { request: match[1] };
}
export function slug(value: string) {
  assert(/^[a-z0-9][a-z0-9-]{0,79}$/.test(value), "Invalid process slug");
  return value;
}
export function frontmatter(text: string): Record<string, any> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert(match, "Missing YAML frontmatter");
  const result = parse(match[1]);
  assert(result && typeof result === "object", "Invalid frontmatter");
  return result;
}
export function approve(text: string) {
  const fm = frontmatter(text);
  assert(
    fm.status === "draft" || fm.status === "replan-draft",
    "Artifact is not awaiting approval",
  );
  return text.replace(
    /^(---\r?\n)[\s\S]*?\r?\n---/,
    (_match, opening: string) =>
      `${opening}${stringify({ ...fm, status: "approved" }).trimEnd()}\n---`,
  );
}
export function validName(name: string) {
  assert(
    name.length <= 400 &&
      name.split("/").length <= 8 &&
      /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/.test(name),
    "Unsafe artifact path",
  );
  return name;
}
export function acceptEdits(
  before: Record<string, string>,
  edits: Record<string, string>,
) {
  assert(
    edits &&
      typeof edits === "object" &&
      !Array.isArray(edits) &&
      Object.keys(edits).length <= 32,
    "Missing authored artifacts",
  );
  const result = { ...before };
  for (const [name, text] of Object.entries(edits)) {
    validName(name);
    assert(
      typeof text === "string" && text.length > 0 && text.length < 128000,
      "Invalid artifact bytes",
    );
    if (name.startsWith("reviews/") || name.startsWith("feedback/")) {
      assert(
        text === before[name],
        "Agent cannot forge or rewrite host-owned review/feedback evidence",
      );
      continue;
    }
    if (name === "config.md") {
      assert(
        text === before[name],
        "Agent cannot silently change selected config",
      );
      continue;
    }
    if (
      before[name] &&
      /^---\r?\n/.test(before[name]) &&
      frontmatter(before[name]).status === "approved"
    )
      assert(
        text === before[name],
        "Agent attempted to mutate approved artifact",
      );
    if (/^---\r?\n/.test(text))
      assert(
        frontmatter(text).status !== "approved" || text === before[name],
        "Agent cannot fabricate approval",
      );
    result[name] = text;
  }
  return result;
}
export function config(route: string, model: string) {
  assert(
    ["full", "quick", "full-plus-ux"].includes(route),
    "Unsupported route template",
  );
  const steps =
    route === "quick"
      ? ["goals", "questions", "research", "plan", "implement", "test"]
      : [
          "goals",
          "questions",
          "research",
          "design",
          "phasing",
          ...(route === "full-plus-ux" ? ["ux"] : []),
          "structure",
          "plan",
          "parallelize",
          "implement",
          "integrate",
          "test",
        ];
  return `---\n${stringify({ created: new Date().toISOString().slice(0, 10), pipeline: route === "quick" ? "quick" : "full", second_reviewer: false, route: steps, verifier_enabled: true, scope_tagger_enabled: true, visual_fidelity_required: false, ...(route === "quick" ? { question_budget: 5 } : {}), model_routing: { "extra-low": "none", low: { vendor: "hosted", model }, medium: { vendor: "hosted", model }, high: { vendor: "hosted", model }, "extra-high": { vendor: "hosted", model } }, default_tier: "medium" })}---\n`;
}
export function checkScope(
  cp: Checkpoint,
  binding: Binding,
  request: any,
  response: any,
  receipt: Receipt,
  reviewers: string[],
) {
  assert(
    JSON.stringify(cp.binding) === JSON.stringify(binding),
    "Checkpoint binding mismatch",
  );
  const a = cp.awaiting;
  assert(
    receipt.resource ===
      `review-requests/${a.requestId}/responses/${response.id}.json`,
    "Wrong response resource",
  );
  assert(
    response.kind === "review-response" &&
      response.reviewer === receipt.reviewer &&
      reviewers.includes(receipt.reviewer),
    "Unauthorized reviewer or draft",
  );
  assert(
    request.workspace === binding.workspace &&
      request.bead_id === binding.bead &&
      request.thread === `threads/${binding.bead}`,
    "Wrong workspace/thread/Bead",
  );
  const p = request.process;
  assert(
    p?.kind === "qrspi" &&
      p.id === binding.process &&
      p.workspace_ref === binding.workspace_ref &&
      p.thread_id === request.thread &&
      samePin(p.config, a.config),
    "Wrong process/config binding",
  );
  assert(
    response.request.id === a.requestId &&
      response.request.version === a.request.version &&
      response.request.snapshot === a.request.snapshot,
    "Stale request response",
  );
  assert(
    request.members.some(
      (m: any) => m.kind === "document" && samePin(m.target, a.artifact),
    ),
    "Artifact not in request",
  );
  assert(
    request.members.some(
      (m: any) => m.kind === "form" && samePin(m.dsl, a.form),
    ),
    "Form not in request",
  );
  assert(
    !response.comments.some((c: any) => c.kind === "feature-comment"),
    "App feature feedback cannot continue content execution",
  );
  const form = response.forms.find((f: any) => samePin(f.dsl, a.form));
  if (response.forms.length === 0) {
    assert(response.comments.length || response.progress.length, "Empty submitted feedback");
    return { approval: false, response };
  }
  assert(
    form && response.forms.length === 1 && form.intent === "discussion",
    "Wrong content decision form or excessive authority",
  );
  const decision = form.answers.decision;
  // Notes/progress submitted without a decision are discussion, not lost feedback.
  if (decision === undefined) return { approval: false, response };
  assert(
    decision &&
      typeof decision === "object" &&
      ["approve", "approve-unverified", "revise", "discuss"].filter((k) => decision[k] === true)
        .length === 1,
    "Ambiguous decision",
  );
  const approval = decision.approve === true || decision["approve-unverified"] === true;
  assert(!approval || (a.approvalOffered && decision[a.approvalChoice ?? "approve"] === true), "Approval was not offered");
  return { approval, response }; // Keep ALL choices/notes; never reduce feedback to a top-level intent.
}
export function validateReviewTarget(
  artifacts: Record<string, string>,
  target: string,
  approvalOffered: boolean,
) {
  // Read-only projection of QRSPI's documented artifact gates, NOT a transition
  // table or scheduler. The orchestrator chooses work; this refuses bypasses.
  const outputs: Record<string, string> = {
    goals: "goals.md",
    questions: "questions.md",
    research: "research/summary.md",
    design: "design.md",
    phasing: "phasing.md",
    structure: "structure.md",
    plan: "plan.md",
    parallelize: "parallelization.md",
  };
  const route = frontmatter(artifacts["config.md"]).route;
  assert(Array.isArray(route), "QRSPI config has no route");
  if (target === "intake.md") {
    assert(
      !approvalOffered &&
        (!artifacts["goals.md"] ||
          frontmatter(artifacts["goals.md"]).status !== "approved"),
      "Intake is discussion-only before Goals approval",
    );
    return;
  }
  const index = route.findIndex((step: string) => outputs[step] === target);
  assert(
    index >= 0,
    "Target has no supported QRSPI authored-artifact gate; pause on an existing artifact instead of inventing execution completion",
  );
  for (const step of route.slice(0, index)) {
    const name = outputs[step];
    assert(
      name &&
        artifacts[name] &&
        frontmatter(artifacts[name]).status === "approved",
      `QRSPI prerequisite not approved: ${step}`,
    );
  }
  assert(artifacts[target], "Missing target artifact");
  if (approvalOffered)
    assert(
      ["draft", "replan-draft"].includes(frontmatter(artifacts[target]).status),
      "Target is not awaiting phase content approval",
    );
}
export function samePin(a: any, b: Pin) {
  return (
    a?.resource === b.resource &&
    a?.version_kind === b.version_kind &&
    a?.version === b.version &&
    a?.snapshot === b.snapshot
  );
}
export function settled(result: any, text: string) {
  assert(result?.status === "completed", "Pi turn did not complete");
  assert(
    result.stopReason !== "cancelled" && text.trim(),
    "Pi produced no successful output",
  );
  return text;
}
export function validateSetupAction(text: string) {
  assert(
    typeof text === "string" && text.length < 64000,
    "Invalid setup action size",
  );
  const action = parse(text);
  assert(
    action?.runs?.using === "composite" && Array.isArray(action.runs.steps),
    "Setup must be a composite action",
  );
  // Setup is trusted caller-opted-in project code, not a general shell sandbox.
  // Keep forbidden legacy bootstraps, telemetry publication and agent dispatch
  // out of this first-party execution path even when a recipe suggests them.
  assert(
    !/\bpython(?:[23](?:\.\d+)?)?\b|upload-artifact|\b(?:acpx|pi-acp|opencode|claude|codex)\b|\bgh\s+workflow\b/i.test(
      text,
    ),
    "Setup contains forbidden legacy execution, agent dispatch or Actions artifacts",
  );
  return action;
}
export function setupGate(plan: { required: boolean }, outcome: string) {
  assert(
    !plan.required || outcome === "success",
    "Required project setup failed; dependent work blocked",
  );
}
