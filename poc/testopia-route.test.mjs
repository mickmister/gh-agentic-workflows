import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TARGET,validateDecision,validateWorkerInput} from './testopia-route.mjs';
const sha='459f1136bf5d6549e0f9b70bbeb10a34b592cbc8';
const pr={number:3,state:'open',base:{ref:TARGET.base},head:{ref:TARGET.branch,sha,repo:{full_name:TARGET.repo}}};
const candidate={workspace_id:'testopia-pr-3',action:'start',formula:'ci-fix',expected_head_sha:sha};
test('start absent workspace is authorized',()=>assert.equal(validateDecision(candidate,pr,{status:'absent'}).target_repo,TARGET.repo));
test('duplicates and incorrect workflow state rejected',()=>{
  for(const status of ['ready','running','awaiting_human','completed'])
    assert.throws(()=>validateDecision(candidate,pr,{status}),/Cannot start/);
  assert.throws(()=>validateDecision({...candidate,action:'resume'},pr,{status:'absent'}),/Resume requires/);
});
test('bad routing and stale model output rejected',()=>{
  for(const patch of [{formula:'shell'},{workspace_id:'testopia-pr-4'},{action:'delete'},{expected_head_sha:'0'.repeat(40)}])
    assert.throws(()=>validateDecision({...candidate,...patch},pr,{status:'absent'}));
});
test('unexpected PR branch, base, state and source rejected',()=>{
  for(const p of [{...pr,head:{...pr.head,ref:'master'}},{...pr,base:{ref:'master'}},{...pr,state:'closed'},{...pr,head:{...pr.head,repo:{full_name:'other/repo'}}}])
    assert.throws(()=>validateDecision(candidate,p,{status:'absent'}));
});
test('worker input must independently validate target and head',()=>{
  const input={...candidate,target_repo:TARGET.repo,pr_number:3};
  assert.equal(validateWorkerInput(input,pr).sha,sha);
  assert.throws(()=>validateWorkerInput({...input,expected_head_sha:'f'.repeat(40)},pr));
  assert.throws(()=>validateWorkerInput({...input,action:'resume'},pr));
});
test('read-only routing does not authorize mutating execution',()=>{
  for(const action of ['await_human','status'])
    assert.equal(validateDecision({...candidate,action},pr,{status:action==='await_human'?'awaiting_human':'running'}).action,action);
});
