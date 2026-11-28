import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assert } from "./core.ts";

export function gitEnvironment(env: NodeJS.ProcessEnv, repository: string, token: string): NodeJS.ProcessEnv {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid GitHub repository");
  // Git URL scopes match path components, not arbitrary string prefixes: repo
  // does not match repo.git. Cover only the two canonical forms of this repo.
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.https://github.com/${repository}.git.extraheader`,
    GIT_CONFIG_KEY_1: `http.https://github.com/${repository}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
}

/** Host-only App auth. No token or signing key is passed to agent tools or setup. */
export class GitHub {
  private tokens = new Map<string, { token: string; expires: number }>();
  private env: NodeJS.ProcessEnv;
  private transport: typeof fetch;
  constructor(env = process.env, transport: typeof fetch = fetch) { this.env = env; this.transport = transport; }
  private jwt() {
    assert(this.env.AGENT_APP_ID && this.env.AGENT_APP_PRIVATE_KEY, "Missing host App credentials");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.env.AGENT_APP_ID })}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(this.env.AGENT_APP_PRIVATE_KEY, "base64url")}`;
  }
  async api(path: string, token: string, method = "GET", body?: unknown) {
    assert(path.startsWith("/repos/") || path.startsWith("/app/") || path.startsWith("/repositories/"), "Invalid GitHub API path");
    const response = await this.transport(`https://api.github.com${path}`, { method, signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const error = new Error(`GitHub API rejected ${method} ${path.split("?")[0]} (${response.status})`);
      Object.assign(error, { $metadata: { httpStatusCode: response.status } });
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  }
  async token(repository: string, access: "read" | "write" | "dispatch" | "inspect" | "pull-request" = "read") {
    assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid GitHub repository");
    const key = `${repository}:${access}`, cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 120000) return cached.token;
    const jwt = this.jwt();
    const installation = await this.api(`/repos/${repository}/installation`, jwt);
    const result = await this.api(`/app/installations/${installation.id}/access_tokens`, jwt, "POST", {
      repositories: [repository.split("/")[1]], permissions: access === "pull-request" ? { contents: "read", pull_requests: "write" }
        : access === "dispatch" || access === "inspect" ? { actions: access === "dispatch" ? "write" : "read", contents: "read" } : { contents: access },
    });
    assert(typeof result.token === "string" && Number.isFinite(Date.parse(result.expires_at)), "Invalid App token response");
    this.tokens.set(key, { token: result.token, expires: Date.parse(result.expires_at) });
    return result.token as string;
  }
  async git(directory: string, args: string[], repository: string, write = false) {
    const token = await this.token(repository, write ? "write" : "read");
    return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 180000, maxBuffer: 8_000_000,
      env: gitEnvironment(this.env, repository, token), stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
}
