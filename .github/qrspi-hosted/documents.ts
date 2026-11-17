import { execFileSync } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assert, type Pin } from "./core.ts";
import { boundedText, limits } from "./bounds.ts";
export class Documents {
  root: string;
  workspace: string;
  constructor(root: string, workspace: string) {
    this.root = root;
    this.workspace = workspace;
  }
  call(args: string[], input?: string): any {
    return JSON.parse(
      execFileSync(
        "nugs",
        [...args, "--remote", process.env.NUGS_STORAGE_URL!],
        {
          cwd: this.root,
          input,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 180000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
  }
  ready(seed: any) {
    // The published explicit CI transport works in an UNATTACHED directory.
    // Do not invent a new machine-local workspace_ref or restore Beads merely
    // to read authored documents. The trusted native handoff supplies identity.
    assert(
      seed.workspace === this.workspace &&
        seed.workspace_ref &&
        seed.engagement,
      "Workspace handoff mismatch",
    );
    return this.call([
      "documents",
      "list",
      "--workspace",
      this.workspace,
      "--limit",
      "1",
    ]);
  }
  read(resource: string, snapshot?: string) {
    const r = this.call([
      "documents",
      "read",
      "--workspace",
      this.workspace,
      "--name",
      resource,
      ...(snapshot ? ["--snapshot", snapshot] : []),
    ]).document;
    assert(r?.text !== undefined && r.version, "Document read failed");
    return r;
  }
  async pin(pin: Pin, current = false) {
    const doc = this.read(pin.resource, current ? undefined : pin.snapshot);
    assert(
      doc.version === pin.version,
      "Document pin mismatch: " + pin.resource,
    );
    return doc.text as string;
  }
  save(resource: string, text: string, previous?: Pin): Pin {
    boundedText(text, limits.document, "publication document");
    const receipt = this.call(
      [
        "documents",
        "upsert",
        "--workspace",
        this.workspace,
        "--name",
        resource,
        "--file",
        "-",
        ...(previous ? ["--expected", previous.version] : []),
      ],
      text,
    ).receipt;
    assert(
      receipt?.version && receipt.commit,
      "Missing native publication receipt",
    );
    const pin: Pin = {
      resource,
      version_kind: "git-blob",
      version: receipt.version,
      snapshot: receipt.commit,
    };
    const doc = this.read(resource, pin.snapshot);
    assert(
      doc.version === pin.version && doc.text === text,
      "Native publication readback mismatch",
    );
    return pin;
  }
}
export async function protocol(root: string) {
  const load = (name: string) =>
    import(pathToFileURL(join(root, "src", name)).href);
  return {
    ...(await load("review-protocol.ts")),
    ...(await load("protocol.ts")),
  };
}
export function publish(root: string, docs: Documents, request: any) {
  const file = join(docs.root, "request-to-publish.json");
  writeFileSync(file, JSON.stringify(request));
  const transport = fileURLToPath(
    new URL("nugs-transport.ts", import.meta.url),
  );
  chmodSync(transport, 0o700);
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "cli/review.ts"),
        "publish",
        "--workspace",
        docs.workspace,
        "--root",
        docs.root,
        "--file",
        file,
        "--repository",
        process.env.REVIEW_REPOSITORY!,
        "--app-url",
        process.env.REVIEW_APP_URL!,
      ],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180000,
        env: { ...process.env, NUGS_BIN: transport },
      },
    ),
  );
  assert(result.receipt?.version && result.link, "Review CLI did not publish");
  const pin: Pin = {
    resource: result.receipt.name,
    version_kind: "git-blob",
    version: result.receipt.version,
    snapshot: result.receipt.commit,
  };
  return { pin, link: result.link };
}
