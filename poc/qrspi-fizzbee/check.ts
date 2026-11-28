// Offline verification harness. Node 22.19+; native FizzBee owns its parser's
// Python dependency. This is not a QRSPI runner or a replacement scheduler.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.FIZZBEE_ROOT;
const output = process.env.FIZZBEE_RESULTS;
if (!root || !output) throw new Error('Set FIZZBEE_ROOT and FIZZBEE_RESULTS to explicit absolute paths');
if (!isAbsolute(root) || !isAbsolute(output)) throw new Error('Checker/results paths must be absolute');
const lock = JSON.parse(readFileSync(join(here, 'checker.lock.json'), 'utf8'));
const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function command(bin: string, args: string[], cwd: string, timeout = 60_000) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  if (r.error || r.signal) throw new Error(`${bin}: ${r.error ?? r.signal}`);
  return { status: r.status, text: r.stdout + r.stderr };
}
if (command('git', ['rev-parse', 'HEAD'], root).text.trim() !== lock.source) throw new Error('Wrong checker source');
if (command('git', ['diff', '--exit-code', 'HEAD'], root).status !== 0) throw new Error('Modified checker source');
for (const [p, hash] of [
  ['fizz', lock.wrapperSha256],
  ['bazel-bin/fizzbee_/fizzbee', lock.checkerSha256],
  ['bazel-bin/parser/parser_bin', lock.parserLauncherSha256],
]) if (digest(join(root, p)) !== hash) throw new Error(`Unqualified checker artifact: ${p}`);
mkdirSync(output, { recursive: true });

type Case = { name: string; model: string; cfg?: string; failure?: string; trace?: string };
const cases: Case[] = [
  { name: 'qualify-positive', model: 'Qualification' },
  { name: 'qualify-safety-negative', model: 'Qualification', cfg: 'BAD_SAFETY=True', failure: 'NamedSafety' },
  { name: 'qualify-witness-negative', model: 'Qualification', cfg: 'BAD_WITNESS=True', failure: 'Reachability' },
  { name: 'qualify-fairness-negative', model: 'Qualification', cfg: 'UNFAIR=True', failure: 'StrictConditionalProgress' },
  { name: 'qualify-ephemeral', model: 'Ephemeral' },
  { name: 'qualify-ephemeral-negative', model: 'Ephemeral', cfg: 'CLAIM_CACHE_DURABLE=True', failure: 'DurableDoesNotImplyCached' },
  { name: 'ordinary-put-overlap', model: 'OrdinaryPut' },
  { name: 'ordinary-put-exactly-once-negative', model: 'OrdinaryPut', cfg: 'CLAIM_EXACTLY_ONCE=True', failure: 'CannotClaimExactlyOnce' },
];
for (const policy of ['proposal', 'boundary', 'cancel']) {
  const cfg = `POLICY="${policy}"\n`;
  for (const witness of ['normal', 'before-dispatch', 'late', 'recovered']) cases.push({
    name: `${policy}-${witness}`, model: 'Parallel', cfg: cfg + `WITNESS="${witness}"`,
  });
  cases.push({ name: `${policy}-aba`, model: 'Parallel', cfg: cfg + 'MAX_CHANGES=2\nWITNESS="aba"' });
}
cases.push(
  { name: 'cancel-late-after-termination', model: 'Parallel', cfg: 'POLICY="cancel"\nWITNESS="cancel-late"' },
  { name: 'irreconcilable-honest-unknown', model: 'Parallel', cfg: 'QUERY=False\nWITNESS="unknown"' },
  { name: 'no-wake-conditional', model: 'Parallel', cfg: 'WAKE=False' },
  { name: 'no-wake-unconditional-negative', model: 'Parallel', cfg: 'WAKE=False\nUNCONDITIONAL=True', failure: 'SubmittedResponseAccountedFor' },
  { name: 'unauthenticated-response', model: 'Parallel', cfg: 'AUTH=False\nWITNESS="rejected"' },
  { name: 'wrong-scope-response', model: 'Parallel', cfg: 'SCOPE=False\nWITNESS="rejected"' },
  { name: 'wrong-occurrence-response', model: 'Parallel', cfg: 'TARGET=1\nWITNESS="rejected"' },
  { name: 'mutation-stale-input', model: 'Parallel', cfg: 'POLICY="proposal"\nMUTATION="stale-input"', failure: 'NoStaleAcceptance' },
  { name: 'mutation-content-only-aba', model: 'Parallel', cfg: 'POLICY="proposal"\nMAX_CHANGES=2\nMUTATION="content-only"', failure: 'NoStaleAcceptance' },
  { name: 'mutation-early-batch', model: 'Parallel', cfg: 'MUTATION="early-batch"', failure: 'NoPrematureFanIn' },
  { name: 'mutation-failed-clean', model: 'Parallel', cfg: 'MUTATION="failed-clean"', failure: 'NoFabricatedCleanResult' },
  { name: 'mutation-blind-replay', model: 'Parallel', cfg: 'MUTATION="blind-replay"', failure: 'NoBlindEffectReplay' },
  { name: 'mutation-stale-resume', model: 'Parallel', cfg: 'MAX_CHANGES=2\nMUTATION="stale-resume"', failure: 'PendingPauseBoundaryHeld' },
  { name: 'trace-normal', model: 'Parallel', trace: 'normal' },
  { name: 'trace-late', model: 'Parallel', trace: 'changed-direction' },
  { name: 'trace-recovered', model: 'Parallel', trace: 'lost-ack' },
);
cases.push(
  { name: 'mini-configuration', model: 'MiniWorkflow' },
  { name: 'mini-duplicate-response', model: 'MiniWorkflow', cfg: 'DUPLICATE=True\nWITNESS="duplicate"' },
  { name: 'mini-mutation-duplicate-response', model: 'MiniWorkflow', cfg: 'DUPLICATE=True\nMUTATION="repeat-response-effect"', failure: 'NoDuplicateResponseEffects' },
  { name: 'mini-draft-is-not-submission', model: 'MiniWorkflow', cfg: 'WITNESS="draft"' },
  { name: 'mini-phase-approval', model: 'MiniWorkflow', cfg: 'KIND="approve"\nWITNESS="approval"' },
  { name: 'mini-conditional-feedback', model: 'MiniWorkflow', cfg: 'KIND="approve"\nCONDITIONS=False\nWITNESS="blocked"' },
  { name: 'mini-wrong-scope', model: 'MiniWorkflow', cfg: 'AUTH=False\nWITNESS="rejected"' },
  { name: 'mini-stale-occurrence', model: 'MiniWorkflow', cfg: 'CURRENT=2\nWITNESS="rejected"' },
  { name: 'mini-lost-publication-recovered', model: 'MiniWorkflow', cfg: 'LOSE_ACK=True\nWITNESS="recovered"' },
  { name: 'mini-unqueryable-publication', model: 'MiniWorkflow', cfg: 'LOSE_ACK=True\nQUERY=False\nWITNESS="unknown"' },
  { name: 'mini-runtime-enforced', model: 'MiniWorkflow', cfg: 'ENFORCEMENT_AVAILABLE=True\nWITNESS="enforced"' },
  { name: 'mini-complete-evidence', model: 'MiniWorkflow', cfg: 'EXPORTS_COMPLETE=True\nWITNESS="evidence"' },
  { name: 'mini-authorized-source', model: 'MiniWorkflow', cfg: 'KIND="approve"\nSOURCE_CAPABILITY=True\nCODE_PERMISSION=True\nWITNESS="source"' },
  { name: 'mini-code-permission-is-not-phase', model: 'MiniWorkflow', cfg: 'SOURCE_CAPABILITY=True\nCODE_PERMISSION=True' },
  { name: 'mini-code-permission-is-not-capability', model: 'MiniWorkflow', cfg: 'KIND="approve"\nCODE_PERMISSION=True\nWITNESS="approval"' },
  { name: 'mini-assessment-partial', model: 'MiniWorkflow', cfg: 'WITNESS="assessment-partial"' },
  { name: 'mini-assessment-complete', model: 'MiniWorkflow', cfg: 'EXPORTS_COMPLETE=True\nWITNESS="assessment-complete"' },
  { name: 'mini-mutation-code-permission', model: 'MiniWorkflow', cfg: 'KIND="approve"\nSOURCE_CAPABILITY=True\nMUTATION="ignore-code-permission"', failure: 'SourcePermissionIsSeparate' },
  { name: 'mini-mutation-assessment-approval', model: 'MiniWorkflow', cfg: 'MUTATION="assessment-approval"', failure: 'ExactPhaseAuthority' },
  { name: 'mini-mutation-assessment-overclaim', model: 'MiniWorkflow', cfg: 'MUTATION="assessment-overclaim"', failure: 'AssessmentNeedsEvidence' },
  { name: 'mini-mutation-config-approval', model: 'MiniWorkflow', cfg: 'MUTATION="configuration-approval"', failure: 'ExactPhaseAuthority' },
  { name: 'mini-mutation-drop-conditions', model: 'MiniWorkflow', cfg: 'KIND="approve"\nCONDITIONS=False\nMUTATION="drop-conditions"', failure: 'ExactPhaseAuthority' },
  { name: 'mini-mutation-hint-authority', model: 'MiniWorkflow', cfg: 'MUTATION="hint-as-authority"', failure: 'HintDoesNotAuthorize' },
  { name: 'mini-mutation-discussion-code', model: 'MiniWorkflow', cfg: 'MUTATION="discussion-code"', failure: 'SourcePermissionIsSeparate' },
  { name: 'mini-mutation-enforcement', model: 'MiniWorkflow', cfg: 'MUTATION="recorded-means-enforced"', failure: 'RecordedIsNotEnforced' },
  { name: 'mini-mutation-evidence', model: 'MiniWorkflow', cfg: 'MUTATION="native-means-complete"', failure: 'NativeIsNotCompleteCoverage' },
  { name: 'mini-mutation-replay', model: 'MiniWorkflow', cfg: 'LOSE_ACK=True\nMUTATION="blind-publication-replay"', failure: 'NoBlindCheckpointReplay' },
  { name: 'evaluators-approve', model: 'EvaluatorLoop' },
  { name: 'evaluators-knowledge-loss-recovered', model: 'EvaluatorLoop', cfg: 'CRASH=True\nWITNESS="recovered"' },
  { name: 'evaluators-approval-before-read', model: 'EvaluatorLoop', cfg: 'WITNESS="unread"' },
  { name: 'evaluators-third-retry', model: 'EvaluatorLoop', cfg: 'PLAN="retry"\nWITNESS="fourth"' },
  { name: 'evaluators-exhaust', model: 'EvaluatorLoop', cfg: 'PLAN="exhaust"\nWITNESS="exhausted"' },
  { name: 'evaluators-no-explicit-mark', model: 'EvaluatorLoop', cfg: 'PLAN="no-marks"\nWITNESS="exhausted"' },
  { name: 'evaluators-old-marks-rejected', model: 'EvaluatorLoop', cfg: 'PLAN="stale"\nWITNESS="exhausted"' },
  { name: 'evaluators-wrong-author-rejected', model: 'EvaluatorLoop', cfg: 'SPOOF=True\nWITNESS="exhausted"' },
  { name: 'evaluators-mutation-no-mark', model: 'EvaluatorLoop', cfg: 'PLAN="no-marks"\nMUTATION="test-pass-is-approval"', failure: 'ThreeExplicitCurrentApprovals' },
  { name: 'evaluators-mutation-stale-mark', model: 'EvaluatorLoop', cfg: 'PLAN="stale"\nMUTATION="old-marks"', failure: 'ThreeExplicitCurrentApprovals' },
  { name: 'evaluators-mutation-author', model: 'EvaluatorLoop', cfg: 'SPOOF=True\nMUTATION="ignore-author"', failure: 'EachEvaluatorOwnsApproval' },
  { name: 'evaluators-mutation-extra-retry', model: 'EvaluatorLoop', cfg: 'PLAN="exhaust"\nMUTATION="four-retries"', failure: 'InitialPlusThreeRetries' },
);
const selected = new Set(process.argv.slice(2));
const results = [];
for (const c of cases.filter(c => selected.size === 0 || selected.has(c.name))) {
  const dir = join(output, c.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, c.model + '.fizz');
  const declarations = new Set<string>();
  const source = readFileSync(join(here, c.model + '.fizz'), 'utf8');
  for (const line of source.split('\n')) {
    const name = line.match(/^(?:(?:atomic|serial|fair(?:<[^>]+>)?|always|exists|eventually|transition)\s+)*(?:action|func|role|assertion)\s+(\w+)/)?.[1]
      ?? line.match(/^([A-Z_][A-Z_0-9]*)\s*=/)?.[1];
    if (!name) continue;
    if (declarations.has(name)) throw new Error(`Duplicate top-level declaration: ${c.model}.${name}`);
    declarations.add(name);
  }
  copyFileSync(join(here, c.model + '.fizz'), file);
  const cfg = c.cfg ?? '';
  writeFileSync(join(dir, 'case.cfg'), cfg);
  const args = ['--preinit-hook-file', join(dir, 'case.cfg'), '--output-dir', join(dir, 'graph'), file];
  if (c.trace) args.unshift('--trace-file', join(here, 'traces', c.trace + '.trace'));
  const started = Date.now();
  const r = command(join(root, 'fizz'), args, dir);
  writeFileSync(join(dir, 'checker.log'), r.text);
  const passed = r.status === 0 && r.text.includes('PASSED: Model checker completed successfully') && !r.text.includes('FAILED:');
  // Upstream currently exits zero on some assertion failures. Require the actual
  // failure banner AND intended named property; compile/tool failures never pass.
  const expectedFailure = r.text.includes('FAILED:') && !!c.failure &&
    r.text.includes(c.failure) && !r.text.includes('Compilation failed');
  if (!(c.failure ? expectedFailure : passed)) {
    console.error(r.text);
    throw new Error(`Unexpected result in ${c.name}; log: ${dir}/checker.log`);
  }
  let traceSha256: string | undefined;
  if (c.trace) {
    const traceFile = join(here, 'traces', c.trace + '.trace');
    traceSha256 = digest(traceFile);
    const expected = readFileSync(traceFile, 'utf8').trim().split('\n');
    const dot = readFileSync(join(dir, 'graph', 'graph.dot'), 'utf8');
    const actual = [...dot.matchAll(/ -> .*?\[label="([^"\n]+)"/g)].map(m => m[1].split('[')[0]);
    if (r.text.includes('WARNING') || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Incomplete trace: ${c.name}`);
    const states = [...dot.matchAll(/State: (\{[^\n]*\})/g)].map(m => JSON.parse(m[1].replaceAll('\\"', '"')));
    const last = states.at(-1);
    const overlapped = states.some(s => s.running[0] && s.running[1]);
    const appropriateEnd = c.trace === 'changed-direction'
      ? last?.late_effect && last.occurrence === 1 && last.accepted === null && last.response[0] === 'applied'
      : last?.accepted?.occurrence === 0 && (c.trace !== 'lost-ack' || (last.lost_ack && last.recovered && last.effects === 1));
    if (!overlapped || !appropriateEnd) throw new Error(`Wrong trace endpoint: ${c.name}`);
  }
  const row = {
    name: c.name, model: c.model, modelSha256: digest(file), config: cfg,
    expected: c.failure ?? 'pass', actual: c.failure ? 'expected-counterexample' : 'pass',
    exitStatus: r.status, elapsedMs: Date.now() - started,
    nodes: r.text.match(/Nodes: (\d+), queued: 0/)?.[1] ? Number(r.text.match(/Nodes: (\d+), queued: 0/)![1]) : null,
    states: r.text.match(/Unique states: (\d+)/)?.[1] ? Number(r.text.match(/Unique states: (\d+)/)![1]) : null,
    logSha256: digest(join(dir, 'checker.log')),
    traceSha256,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
if (!results.length) throw new Error('No matching cases');
writeFileSync(join(output, selected.size ? 'selected-summary.json' : 'summary.json'), JSON.stringify({ checker: lock, results }, null, 2) + '\n');
