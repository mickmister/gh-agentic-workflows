/** Translate explicit Actions inputs into the existing launcher config. No task routing. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const phase = process.argv[2];
if (!['setup', 'work', 'exit'].includes(phase)) throw new Error('Unknown message');
const env = process.env;
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(env.BEAD_ID)) throw new Error('Invalid Bead');
const root = env.GC_WORKSPACE_ROOT;
const context = JSON.parse(execFileSync('nugs', ['workspace', 'context'], {cwd: root, encoding: 'utf8'}));
const run = 'hermes-' + env.BEAD_ID.toLowerCase().replaceAll('.', '-');
const base = path.join(env.GC_ATTEMPT_ROOT, phase);
const previous = phase === 'setup' ? null : path.join(env.GC_ATTEMPT_ROOT,
  phase === 'work' || !fs.existsSync(path.join(env.GC_ATTEMPT_ROOT, 'work/report.json')) ? 'setup' : 'work', 'report.json');
const request = phase === 'setup'
  ? `Work on Bead ${env.BEAD_ID}. First read it using bd from ${root}, inspect relevant prior workflow-runs through nugs in this attached workspace, and inspect available project recipes. ` +
    `Choose/reuse or create/update the provisional setup action at ${env.GC_SETUP_SLOT}. A no-op action is already there; keep it if sufficient. ` +
    `Record operator notes explaining why the action exists and its current scope. Finish this turn when ready for Actions to execute that action. ` +
    `Do not begin production implementation until the setup action has run.\nOperator context: ${env.BEAD_INSTRUCTIONS || ''}`
  : phase === 'work'
    ? `The selected setup action finished with outcome ${env.GC_SETUP_OUTCOME}. Inspect actual readiness and handle the assigned Bead. ` +
      `Use the original scope and project preferences. Decide from evidence whether to continue prior work or start distinct work. ` +
      `Keep useful outcomes, blockers, exact candidate/test/PR references and unfinished work discoverable through nugs for this workspace. ` +
      `Commit and push intended source changes to task branches before ending, including clearly labelled unfinished work when appropriate. Do not merge/release. ` +
      `This task may use direct tools provisionally; Gas City remains required in the final architecture.`
    : fs.readFileSync(path.join(env.GC_ENGINE_ROOT, '.github/hermes/exit-followup.md'), 'utf8') +
      `\nObserved Actions outcomes: setup=${env.GC_SETUP_OUTCOME}; work=${env.GC_WORK_OUTCOME}.`;
const config = {
  nugs: env.GC_NUGS, root, workspace_ref: context.workspace_ref, run,
  task: env.BEAD_ID, purpose: `Hermes handles ${env.BEAD_ID}`,
  attempt: `r${env.GITHUB_RUN_ID}-a${env.GITHUB_RUN_ATTEMPT}-${phase}`,
  base, hermes: env.HERMES_BINARY, model: 'gpt-6.1-sol', provider: 'custom',
  cwd: root, native_tools_home: env.HOME, toolsets: 'terminal,file,memory',
  max_turns: phase === 'setup' ? 12 : phase === 'exit' ? 15 : 50,
  timeout_seconds: phase === 'setup' ? 240 : phase === 'exit' ? 300 : 1200,
  max_children: 3, request,
  instructions: fs.readFileSync(path.join(env.GC_ENGINE_ROOT, '.github/hermes/working-instructions.md'), 'utf8'),
  pass_environment: ['INFERENCE_BASE_URL', 'INFERENCE_API_KEY', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
    'GH_TOKEN', 'NUGS_STORAGE_URL', 'NUGS_STORAGE_TOKEN', 'BD_NO_HOOKS', 'BEADS_DOLT_SHARED_SERVER',
    ...Object.keys(env).filter(key => key.startsWith('GC_') || key.startsWith('S3_CACHE_'))],
  ...(previous ? {resume_from: previous} : {}),
};
fs.writeFileSync(path.join(env.GC_ATTEMPT_ROOT, phase + '.json'), JSON.stringify(config), {mode: 0o600});
