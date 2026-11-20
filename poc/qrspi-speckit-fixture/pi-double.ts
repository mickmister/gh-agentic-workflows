#!/usr/bin/env -S node --experimental-strip-types
import {join} from 'node:path';
import {read,save,wait} from './common.ts';
const root=process.env.FIXTURE_CASE!;const m=read(join(root,'expected.json'));
const argv=process.argv.slice(2);
if(argv.length!==4||argv[0]!=='-p'||argv[2]!=='--mode'||argv[3]!=='json')throw Error('unexpected Pi argv');
const worker=argv[1].split(' ')[1];
if(!m.required.includes(worker)||argv[1]!==`/speckit.fixture-worker ${worker} ${JSON.stringify(m.identity)}`||process.cwd()!==join(root,'project'))throw Error('prompt/cwd mismatch');
save(join(root,`arrival-${worker}.json`),{worker,argv,cwd:process.cwd(),identity:m.identity,pid:process.pid});
try{await wait(join(root,'release.json'));}catch(e){
 if(m.policy!=='success')throw e;
 const receipt={worker,identity:m.identity,pid:process.pid,reason:'unreleased-barrier',release:join(root,'release.json')};
 save(join(root,`barrier-timeout-${worker}.json`),receipt);
 console.error(JSON.stringify({type:'fixture_barrier_timeout',...receipt}));
 process.exit(23);
}
const release=read(join(root,'release.json')).id;
if(m.policy==='halting-failure'&&worker==='w1')await wait(join(root,'allow-late.json'));
const failed=m.policy!=='success'&&worker==='w0';
const outcome={...m.identity,worker,verdict:failed?'failed':'clean',release,evidence:'deterministic-double'};
console.log(JSON.stringify({type:'agent_start'}));
console.log(JSON.stringify({type:'fixture_terminal',outcome}));
save(join(root,`effect-${worker}.json`),outcome);
if(failed)save(join(root,'failure.json'),{worker,release});
process.exitCode=failed?7:0;
