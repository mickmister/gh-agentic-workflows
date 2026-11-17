import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateReviewTarget,
  admissionIdentity,
  acceptEdits,
  approve,
  checkScope,
  config,
  frontmatter,
  setupGate,
  type Checkpoint,
  type Pin,
} from "./core.ts";
import { protocol } from "./documents.ts";
const pin = (resource: string, letter = "a"): Pin => ({
  resource,
  version_kind: "git-blob",
  version: letter.repeat(40),
  snapshot: "b".repeat(40),
});
const binding = {
  workspace: "test",
  workspace_ref: "ws-" + "1".repeat(32),
  process: "new-process",
  bead: "task-3vt.50.51",
};
function fixture() {
  const requestId = "test-request";
  const cp: Checkpoint = {
    binding,
    artifacts: {
      "config.md": config("full", "test-model"),
      "goals.md": "---\nstatus: draft\n---\n# Goals\n",
    },
    pins: {},
    awaiting: {
      requestId,
      request: pin(`review-requests/${requestId}/request.json`),
      artifact: pin(
        "projects/agentic-workflows/qrspi/runs/new-process/goals.md",
      ),
      config: pin(
        "projects/agentic-workflows/qrspi/runs/new-process/config.md",
      ),
      form: pin(`review-requests/${requestId}/forms/phase-decision.json`),
      artifactName: "goals.md",
      approvalOffered: true,
    },
  };
  const form = {
    format: "standard",
    id: "phase-decision",
    task_id: binding.bead,
    title: "Decision",
    allowCodeFileChanges: false,
    questions: [
      {
        id: "decision",
        title: "Choose",
        type: "choices",
        required: true,
        choices: ["approve", "revise", "discuss"].map((id) => ({
          id,
          label: id,
        })),
        choiceGroups: [
          {
            id: "one",
            mode: "exactlyOne",
            choiceIds: ["approve", "revise", "discuss"],
          },
        ],
      },
      { id: "notes", type: "textarea", title: "Notes" },
    ],
  };
  const request = {
    kind: "review-request",
    schema_version: 1,
    request_id: requestId,
    revision_id: "rev-one",
    workspace: binding.workspace,
    bead_id: binding.bead,
    thread: `threads/${binding.bead}`,
    title: "Goals",
    purpose: "Content review",
    question: "Approve exact Goals?",
    status: "published",
    change_kind: "proposal",
    process: {
      kind: "qrspi",
      id: binding.process,
      workspace_ref: binding.workspace_ref,
      thread_id: `threads/${binding.bead}`,
      config: cp.awaiting.config,
    },
    members: [
      {
        kind: "document",
        id: "artifact",
        label: "Goals",
        target: cp.awaiting.artifact,
      },
      {
        kind: "form",
        id: "decision",
        label: "Decision",
        bead_id: binding.bead,
        form_id: "phase-decision",
        dsl: cp.awaiting.form,
      },
    ],
  };
  const response = {
    kind: "review-response",
    schema_version: 1,
    transport: "workspace-resources",
    id: "response-one",
    request: {
      id: requestId,
      version: cp.awaiting.request.version,
      snapshot: cp.awaiting.request.snapshot,
    },
    reviewer: "github:123",
    intent: "feedback",
    forms: [
      {
        member_id: "decision",
        bead_id: binding.bead,
        form_id: "phase-decision",
        dsl: cp.awaiting.form,
        intent: "discussion",
        answers: { decision: { approve: true }, notes: "Keep every note" },
      },
    ],
    comments: [],
    progress: [],
  };
  const receipt = {
    resource: `review-requests/${requestId}/responses/response-one.json`,
    version: "c".repeat(40),
    snapshot: "d".repeat(40),
    reviewer: response.reviewer,
  };
  return { cp, request, response, receipt, form };
}
test("fresh canonical config has actual full/quick routes and required five-tier model routing, no historical approvals", () => {
  for (const mode of ["full", "quick", "full-plus-ux"]) {
    const fm = frontmatter(config(mode, "model"));
    assert.equal(fm.route[0], "goals");
    assert.equal(Object.keys(fm.model_routing).length, 5);
    assert.equal(fm.route.includes("replan"), false);
    assert.equal("question_budget" in fm, mode === "quick");
    assert.equal("status" in fm, false);
  }
});
test("start, revise and exact approval alter artifacts, never a scheduler status", () => {
  const { cp, request, response, receipt } = fixture();
  const started = acceptEdits(
    { "config.md": cp.artifacts["config.md"] },
    { "goals.md": cp.artifacts["goals.md"] },
  );
  const revised = acceptEdits(started, {
    "goals.md": started["goals.md"] + "Clarified problem\n",
  });
  const reviseResponse = structuredClone(response);
  reviseResponse.forms[0].answers.decision = { approve: false } as any;
  Object.assign(reviseResponse.forms[0].answers.decision, { revise: true });
  assert.equal(
    checkScope(cp, binding, request, reviseResponse, receipt, ["github:123"])
      .approval,
    false,
  );
  assert.equal(frontmatter(revised["goals.md"]).status, "draft");
  const admitted = checkScope(cp, binding, request, response, receipt, [
    "github:123",
  ]);
  assert.equal(admitted.approval, true);
  assert.equal(admitted.response.forms[0].answers.notes, "Keep every note");
  const approved = { ...revised, "goals.md": approve(revised["goals.md"]) };
  assert.equal(frontmatter(approved["goals.md"]).status, "approved");
  assert.equal(
    frontmatter(
      acceptEdits(approved, {
        "questions.md": "---\nstatus: draft\n---\nQuestions\n",
      })["questions.md"],
    ).status,
    "draft",
  );
  assert.throws(
    () => acceptEdits(approved, { "goals.md": revised["goals.md"] }),
    /mutate approved/,
  );
  assert.throws(
    () =>
      acceptEdits(started, {
        "design.md": "---\nstatus: approved\n---\nFake approval",
      }),
    /fabricate/,
  );
  assert.throws(() => acceptEdits(started, { "../evil.md": "bad" }), /Unsafe/);
});
const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  "forged reviewer": (f) => {
    f.receipt.reviewer = "github:999";
  },
  "unallowed reviewer": (f) => {
    f.response.reviewer = f.receipt.reviewer = "github:999";
  },
  "wrong response path": (f) => {
    f.receipt.resource =
      "review-requests/elsewhere/responses/response-one.json";
  },
  "stale request": (f) => {
    f.response.request.version = "e".repeat(40);
  },
  "wrong snapshot": (f) => {
    f.response.request.snapshot = "e".repeat(40);
  },
  "wrong workspace": (f) => {
    f.request.workspace = "elsewhere";
  },
  "wrong Bead": (f) => {
    f.request.bead_id = "task-other";
  },
  "wrong process": (f) => {
    f.request.process.id = "elsewhere";
  },
  "wrong config pin": (f) => {
    f.request.process.config = {
      ...f.request.process.config,
      version: "e".repeat(40),
    };
  },
  "wrong artifact pin": (f) => {
    (f.request.members[0] as any).target = pin("wrong.md");
  },
  "wrong form pin": (f) => {
    (f.request.members[1] as any).dsl = pin("wrong.json");
  },
  "app feature feedback": (f) => {
    (f.response.comments as any[]).push({ kind: "feature-comment" });
  },
  "ambiguous decision": (f) => {
    (f.response.forms[0].answers.decision as any).revise = true;
  },
  "approval never offered": (f) => {
    f.cp.awaiting.approvalOffered = false;
  },
  "wrong intent": (f) => {
    f.response.forms[0].intent = "approved-next-steps";
  },
  "draft response": (f) => {
    f.response.kind = "review-draft";
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`reject ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      checkScope(f.cp, binding, f.request, f.response, f.receipt, [
        "github:123",
      ]),
    );
  });
test("comment/progress-only submitted content is discussion; exact unverified choice is distinct", () => {
  const f = fixture();
  const commentsOnly: any = { ...f.response, forms: [], comments: [{ kind: "content-comment", text: "Correction", quote: "quoted" }], progress: ["artifact"] };
  const discussion = checkScope(f.cp, binding, f.request, commentsOnly, f.receipt, ["github:123"]);
  assert.equal(discussion.approval, false);
  assert.deepEqual(discussion.response, commentsOnly);
  const notesOnly: any = structuredClone(f.response);
  delete notesOnly.forms[0].answers.decision;
  assert.equal(checkScope(f.cp, binding, f.request, notesOnly, f.receipt, ["github:123"]).approval, false);
  f.cp.awaiting.approvalChoice = "approve-unverified";
  assert.throws(() => checkScope(f.cp, binding, f.request, f.response, f.receipt, ["github:123"]), /not offered/);
  (f.response.forms[0].answers as any).decision = { "approve-unverified": true };
  assert.equal(checkScope(f.cp, binding, f.request, f.response, f.receipt, ["github:123"]).approval, true);
});
test("intake can ask a grounded first question without fabricating locked Goals or approval", () => {
  const artifacts = {
    "config.md": config("full", "test"),
    "intake.md": "# Intake\nActual caller intent; one open question.\n",
  };
  validateReviewTarget(artifacts, "intake.md", false);
  assert.throws(
    () => validateReviewTarget(artifacts, "intake.md", true),
    /discussion-only/,
  );
});
test("QRSPI artifact predecessor guards refuse phase skipping and invented execution completion", () => {
  const { cp } = fixture();
  const artifacts: Record<string, string> = {
    ...cp.artifacts,
    "questions.md": "---\nstatus: draft\n---\nQuestions\n",
  };
  assert.throws(
    () => validateReviewTarget(artifacts, "questions.md", true),
    /prerequisite/,
  );
  artifacts["goals.md"] = approve(artifacts["goals.md"]);
  validateReviewTarget(artifacts, "questions.md", true);
  assert.throws(
    () => validateReviewTarget(artifacts, "implement.md", true),
    /cannot offer phase approval/,
  );
  artifacts["discussion/tradeoffs.md"] = "# Tradeoffs\nNo phase completion claimed.";
  validateReviewTarget(artifacts, "discussion/tradeoffs.md", false);
  assert.throws(() => validateReviewTarget(artifacts, "discussion/tradeoffs.md", true), /cannot offer phase approval/);
});
test("alternate snapshots, reviewers and response IDs cannot bypass an uncertain awaited-request admission", () => {
  const { receipt } = fixture();
  assert.deepEqual(
    admissionIdentity(receipt),
    admissionIdentity({
      ...receipt,
      snapshot: "f".repeat(40),
      version: "e".repeat(40),
      reviewer: "github:999",
      resource: receipt.resource.replace("response-one", "response-two"),
    }),
  );
  assert.throws(() =>
    admissionIdentity({ ...receipt, resource: "arbitrary/comments.json" }),
  );
});
test("required setup gates work; optional/noop setup is work-first", () => {
  assert.throws(() => setupGate({ required: true }, "failure"), /Required/);
  assert.throws(() => setupGate({ required: true }, "skipped"), /Required/);
  setupGate({ required: true }, "success");
  setupGate({ required: false }, "failure");
  setupGate({ required: false }, "success");
});
test(
  "production github-ultimate parsers validate the exact shared fixture and reject mismatched pins",
  { skip: !process.env.GITHUB_ULTIMATE_ROOT },
  async () => {
    const f = fixture();
    const p = await protocol(process.env.GITHUB_ULTIMATE_ROOT!);
    const request = p.parseReviewRequest(JSON.stringify(f.request));
    const response = p.parseReviewArtifact(JSON.stringify(f.response));
    p.parseRecord(JSON.stringify(f.form));
    await p.validateReviewArtifact(request, response, async () =>
      JSON.stringify(f.form),
    );
    response.forms[0].dsl = {
      ...response.forms[0].dsl,
      version: "e".repeat(40),
    };
    await assert.rejects(
      p.validateReviewArtifact(request, response, async () =>
        JSON.stringify(f.form),
      ),
      /pinned form identity/,
    );
  },
);
