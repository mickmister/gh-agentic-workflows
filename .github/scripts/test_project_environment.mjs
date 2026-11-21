import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {materialize, snapshot, validateLaunch} from './project-environment.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding:'utf8'}).trim();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-environment-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  const action = JSON.stringify({name:'fixture', description:'fixture', runs:{using:'composite', steps:[{shell:'bash',run:'true'}]}});
  for (const location of ['projects/demo', '.agentic']) {
    fs.mkdirSync(path.join(repo, location, 'actions/setup'), {recursive:true});
    fs.writeFileSync(path.join(repo, location, 'actions/setup/action.yml'), action);
    fs.writeFileSync(path.join(repo, location, 'initialization.json'), '{}');
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo,'checkout','-qb','project/other');git(repo,'rm','-qr','projects');git(repo,'commit','-qm','separate project branch');
  const branchSha=git(repo,'rev-parse','HEAD');git(repo,'checkout','-q','main');
  const workspace = path.join(root,'workspace');
  fs.mkdirSync(path.join(workspace,'sources'),{recursive:true});
  const sources = {};
  for(const id of ['app','contracts']) {
    sources[id]=path.join(workspace,'sources',id);
    execFileSync('git',['clone','-q','--no-hardlinks',repo,sources[id]]);
  }
  const launch = {schema:1,installation:'fixture',projects:[{id:'demo',repository:'fixture/config',sha,path:'projects/demo',recipe:'js-checks',members:['app','contracts']}],
    sources:['app','contracts'].map(id=>({id,repository:`fixture/${id}`,sha,access:id==='app'?'write':'read'}))};
  return {root,repo,sha,branchSha,workspace,sources,launch};
}
test('same bytes in main-directory and branch-root layouts have equal effective identity',t=>{
  const f=fixture(t);
  assert.equal(snapshot(f.repo,f.sha,'projects/demo').digest,snapshot(f.repo,f.sha,'.agentic').digest);
  assert.notEqual(f.sha,f.branchSha);
  assert.equal(snapshot(f.repo,f.sha,'projects/demo').digest,snapshot(f.repo,f.branchSha,'.agentic').digest);
  fs.writeFileSync(path.join(f.repo,'projects/demo/initialization.json'),'{"generation":2}');
  fs.writeFileSync(path.join(f.repo,'unrelated.txt'),'another project');
  git(f.repo,'add','.');git(f.repo,'commit','-qm','bookkeeping');
  assert.equal(snapshot(f.repo,git(f.repo,'rev-parse','HEAD'),'projects/demo').digest,snapshot(f.repo,f.sha,'projects/demo').digest);
  // Dirty config is never accidentally used instead of the pinned commit.
  fs.writeFileSync(path.join(f.repo,'projects/demo/actions/setup/action.yml'),'not the pinned action');
  assert.equal(snapshot(f.repo,f.sha,'projects/demo').digest,snapshot(f.repo,f.sha,'.agentic').digest);
});
test('mixed layouts produce distinct preserved slots and a two-member source vector',t=>{
  const f=fixture(t);
  f.launch.projects.push({...f.launch.projects[0],id:'other',sha:f.branchSha,path:'.agentic',members:['contracts']});
  const result=materialize(f.launch,f.workspace,{projects:{demo:f.repo,other:f.repo},sources:f.sources});
  assert.deepEqual(Object.keys(result.sources),['app','contracts']);
  assert.equal(result.phase,'materialized-not-executed');
  const action=JSON.parse(fs.readFileSync(path.join(f.workspace,'.agentic/active-setup/action.yml')));
  assert.deepEqual(action.runs.steps.map(s=>s.uses),['./.agentic/projects/demo/actions/setup','./.agentic/projects/other/actions/setup']);
  assert.throws(()=>materialize(f.launch,f.workspace,{projects:{demo:f.repo,other:f.repo},sources:f.sources}),/slots already exist/);
});
test('missing members, traversal, invalid refs, dirty source and symlink recipes fail explicitly',t=>{
  const f=fixture(t);
  assert.throws(()=>validateLaunch({...f.launch,sources:f.launch.sources.slice(0,1)}),/Missing source/);
  assert.throws(()=>validateLaunch({...f.launch,projects:[{...f.launch.projects[0],path:'../escape'}]}),/relative path/);
  assert.throws(()=>snapshot(f.repo,'main','projects/demo'),/full commit/);
  fs.writeFileSync(path.join(f.sources.app,'dirty'),'changes');
  assert.throws(()=>materialize(f.launch,f.workspace,{projects:{demo:f.repo},sources:f.sources}),/dirty/);
  fs.symlinkSync('/etc/passwd',path.join(f.repo,'projects/demo/leak'));
  git(f.repo,'add','.');git(f.repo,'commit','-qm','bad recipe');
  assert.throws(()=>snapshot(f.repo,git(f.repo,'rev-parse','HEAD'),'projects/demo'),/Unsupported/);
});
