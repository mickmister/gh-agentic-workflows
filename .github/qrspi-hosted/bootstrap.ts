import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert } from "./core.ts";
const operation = process.argv[2];
if (operation === "storage-target") {
  const url = new URL(process.env.NUGS_STORAGE_URL!);
  assert(
    url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password,
    "Expected credential-free GitHub storage URL",
  );
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  assert(
    parts.length === 2 && parts.every((p) => /^[\w.-]+$/.test(p)),
    "Invalid storage repository",
  );
  appendFileSync(
    process.env.GITHUB_OUTPUT!,
    `owner=${parts[0]}\nrepository=${parts[1]}\n`,
  );
} else if (operation === "credential") {
  const url = new URL(process.env.NUGS_STORAGE_URL!);
  const query = Object.fromEntries(
    readFileSync(0, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  if (
    process.argv[3] === "get" &&
    query.protocol === url.protocol.slice(0, -1) &&
    query.host === url.host &&
    query.path === url.pathname.slice(1)
  ) {
    assert(process.env.NUGS_STORAGE_TOKEN, "Missing storage App token");
    process.stdout.write(
      `username=x-access-token\npassword=${process.env.NUGS_STORAGE_TOKEN}\n\n`,
    );
  }
} else if (operation === "init") {
  const home = resolve(process.env.RUNNER_TEMP!, "qrspi-host");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const helper = `!${process.execPath} --experimental-strip-types ${fileURLToPath(import.meta.url)} credential`;
  // Published nugs removes all GIT_* overrides before invoking Git. HOME is
  // preserved, so credentials must also live at Git's conventional private path.
  const gitconfig = join(home, ".gitconfig");
  writeFileSync(
    gitconfig,
    `[credential]\n\tuseHttpPath = true\n\thelper = ${helper}\n[user]\n\tname = QRSPI Hosted\n\temail = qrspi@users.noreply.github.com\n`,
    { mode: 0o600 },
  );
  appendFileSync(
    process.env.GITHUB_ENV!,
    `HOME=${home}\nXDG_CONFIG_HOME=${home}/config\nXDG_CACHE_HOME=${home}/cache\nXDG_DATA_HOME=${home}/data\nGIT_CONFIG_GLOBAL=${gitconfig}\nQRSPI_HOME=${home}\n`,
  );
  appendFileSync(
    process.env.GITHUB_PATH!,
    resolve(".github/qrspi-hosted/node_modules/.bin") + "\n",
  );
  // Source readiness before optional preparation; no app build or native Beads restore is needed for document work.
  const source = join(home, "source");
  execFileSync(
    "git",
    ["clone", "--no-hardlinks", "--quiet", process.cwd(), source],
    { stdio: "pipe" },
  );
  appendFileSync(process.env.GITHUB_ENV!, `QRSPI_SOURCE=${source}\n`);
} else throw new Error("Unknown bootstrap operation");
