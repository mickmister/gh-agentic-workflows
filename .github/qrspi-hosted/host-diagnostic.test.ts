import { test } from "node:test";
import assert from "node:assert/strict";
import { hostDiagnostic, hostErrorDetails } from "./inspect.ts";
test("opt-in read-only Beads tool stderr is selected without exposing command arguments", () => {
  const message = "Command failed: bd --sandbox show task-private --json --readonly\nError: no database found\nPRIVATE-SECOND-LINE";
  assert.equal(hostErrorDetails(message, {}), undefined);
  assert.equal(hostErrorDetails(message, { HOST_ERROR_DETAILS: "true" }), "Error: no database found [additional lines omitted]");
  assert.equal(hostErrorDetails(message.replace("Error:", "warning: role unset\nError:"), { HOST_ERROR_DETAILS: "true" }), "Error: no database found [additional lines omitted]");
  assert.equal(hostErrorDetails("Command failed: bd update task-private --json\nPRIVATE", { HOST_ERROR_DETAILS: "true" }), undefined);
});

test("read-only checkout diagnostics select constants and HTTP status without exposing private text", () => {
  assert.deepEqual(hostDiagnostic("GitHub API rejected operation (404)"), { reason: "github-api-rejected", httpStatus: 404 });
  assert.deepEqual(hostDiagnostic("GitHub API rejected GET /repos/private-owner/private-repo/installation (403)"), { reason: "github-api-rejected", httpStatus: 403 });
  assert.deepEqual(hostDiagnostic("Command failed: git -C /private/source fetch origin secret-ref\nfatal: could not read Username for 'https://private.invalid': terminal prompts disabled\nSECRET"), { reason: "git-command-failed", authenticationRequired: true });
  assert.equal(hostDiagnostic("arbitrary private prose SECRET"), undefined);
  assert.equal(hostDiagnostic("GitHub API rejected operation (403)\nSECRET"), undefined);
  assert.equal(hostDiagnostic({ message: "SECRET" }), undefined);
});

test("opt-in bound nugs stderr is scrubbed before selection; command/native payloads remain hidden", () => {
  const message = "Command failed: nugs workspace restore --root /private --remote https://private.invalid\ninvalid workspace handoff object\nSECRET extra lines";
  assert.equal(hostErrorDetails(message, {}), undefined);
  assert.equal(hostErrorDetails(message, { HOST_ERROR_DETAILS: "true", NUGS_STORAGE_TOKEN: "SECRET" }), "invalid workspace handoff object [additional lines omitted]");
  assert.equal(hostErrorDetails("Command failed: arbitrary program\nSECRET", { HOST_ERROR_DETAILS: "true" }), undefined);
  assert.equal(hostErrorDetails("Invalid checkpoint members", { HOST_ERROR_DETAILS: "true" }), "Invalid checkpoint members");
  const schema = hostErrorDetails(JSON.stringify([{ code: "invalid_type", path: ["questions", 0, "PRIVATE-FIELD"], message: "PRIVATE-VALUE", input: "PRIVATE-INPUT" }]), { HOST_ERROR_DETAILS: "true" });
  assert.deepEqual(JSON.parse(schema!), [{ code: "invalid_type", path: ["questions", 0, "field"] }]);
  assert.equal(hostErrorDetails("Command failed: nugs beads sync --root /private\nhttps://credential@private.invalid token=foo", { HOST_ERROR_DETAILS: "true" })?.includes("private.invalid"), false);
});
