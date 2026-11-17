// Public diagnostics are selected constants/numbers, never provider prose.
const awsCodes = new Set([
  "NoSuchKey", "NotFound", "NoSuchBucket", "AccessDenied", "InvalidAccessKeyId",
  "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken", "RequestTimeTooSkewed",
  "AuthorizationHeaderMalformed", "PermanentRedirect", "SlowDown", "ServiceUnavailable",
  "InternalError", "RequestTimeout", "PreconditionFailed", "ConditionalRequestConflict",
  "NotImplemented", "InvalidRequest", "InvalidArgument", "BadDigest", "XAmzContentSHA256Mismatch",
]);
const nodeCodes = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ENOSPC", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);
export function classify(error: unknown) {
  const e = error as { name?: unknown; code?: unknown; status?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const code = [e?.name, e?.code].find((v): v is string => typeof v === "string" && awsCodes.has(v));
  const nodeCode = typeof e?.code === "string" && nodeCodes.has(e.code) ? e.code : undefined;
  const rawStatus = e?.$metadata?.httpStatusCode;
  const httpStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const rawExit = typeof e?.code === "number" ? e.code : e?.status;
  const exitCode = typeof rawExit === "number" && Number.isInteger(rawExit) && rawExit >= 0 && rawExit <= 255 ? rawExit : undefined;
  return { category: code ? "aws" : nodeCode ? "node" : exitCode !== undefined ? "child-exit" : httpStatus ? "http" : "unclassified", ...(code ? { code } : {}), ...(nodeCode ? { nodeCode } : {}), ...(httpStatus ? { httpStatus } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}
export function missingObject(error: unknown) {
  const safe = classify(error);
  // A bare 404 (or NoSuchBucket) does not establish object absence.
  return safe.httpStatus === 404 && (safe.code === "NoSuchKey" || safe.code === "NotFound");
}
export const stages = ["initialization", "receipt-authentication", "admission-read", "binding-readiness", "protocol-readiness", "documents-readiness", "checkpoint-read", "exact-response-validation", "start-validation", "admission-write", "artifact-materialization", "prepare-project", "setup-materialization", "setup-evidence", "admission-output", "invocation-read", "setup-gate", "approval-consistency", "approval-publication", "orchestrator", "questions-author", "artifact-validation", "independent-review", "publication-validation", "artifact-publication", "request-publication", "checkpoint-write", "admission-settle", "run-reference", "exit-interview"] as const;
export type Stage = typeof stages[number];
export async function reportFailure(stage: Stage, error: unknown, archive: () => Promise<unknown>) {
  let stored = false;
  let archivalFailure;
  try { await archive(); stored = true; } catch (failure) { archivalFailure = classify(failure); }
  return { diagnosticOnly: true, stage: stages.includes(stage) ? stage : "initialization", failure: classify(error), privateEvidenceStored: stored, ...(archivalFailure ? { archivalFailure } : {}), notice: "Stopped. Absent or uncertain admission never authorizes replay; reconcile private evidence before any process start." };
}
