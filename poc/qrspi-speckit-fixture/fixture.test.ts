import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {sequentialWitness} from './sequential.ts';
import {join,dirname} from 'node:path';
import {validate} from './accept.ts';
import {observe} from './history.ts';
import {qualifiedInventory} from './preflight.ts';
import {save,command} from './common.ts';
import type {Captured,Outcome} from './common.ts';
process.umask(0o077);
const output=mkdtempSync('/var/lib/vd/scripts/vk/46e5-vd-multi-instanc/qrspi-speckit-fixture-impl-g1/fix-g1-tests-');
const identity={task:'task',execution:'exec',occurrence:2,content:'A',attempt:1};
const manifest=Object.freeze({identity:Object.freeze(identity),required:Object.freeze(['w0','w1'])});
const outcomes=():Outcome[]=>manifest.required.map(worker=>({...identity,worker,verdict:'clean',release:'release',evidence:'test'}));
const captures=(os:Outcome[]):Captured[]=>os.map(o=>({exit_code:0,dispatched:true,stdout:JSON.stringify({type:'agent_start'})+'\n'+JSON.stringify({type:'fixture_terminal',outcome:o})+'\n'}));
let counter=0;
function observation(os:Outcome[],cs:Captured[],review=true){
 const root=join(output,String(counter++));mkdirSync(root);
 save(join(root,'promotion.json'),{review:{outcomes:os}});
 save(join(root,'validated.json'),os);
 if(review)save(join(root,'review.json'),{outcomes:os});
 save(join(root,'release.json'),{id:'release',arrivals:[{worker:'w0'},{worker:'w1'}]});
 for(const o of outcomes())save(join(root,`effect-${o.worker}.json`),o);
 return ()=>observe(root,manifest,{step_results:{workers:{output:{results:cs}}}});
}
test('positive reaches review/promotion; independent history agrees',()=>{
 const os=outcomes(),cs=captures(os);assert.equal(validate(cs,identity,[...manifest.required],'release').length,2);assert.equal(observation(os,cs)().promoted,true);
});
const corruptions:Record<string,(os:Outcome[],cs:Captured[])=>void>={
 missing:(o,c)=>{o.pop();c.pop();},duplicate:(o,c)=>{o[1]=o[0];c[1]=c[0];},
 task:o=>{o[0].task='wrong';},execution:o=>{o[0].execution='old';},
 occurrence:o=>{o[0].occurrence=0;},content:o=>{o[0].content='B';},attempt:o=>{o[0].attempt=0;},worker:o=>{o[0].worker='unknown';},
 'exit0-failed-verdict':o=>{o[0].verdict='failed';},'nonzero-clean':(_o,c)=>{c[0].exit_code=7;},
 malformed:(_o,c)=>{c[0].stdout='{\n';},'absent-terminal':(_o,c)=>{c[0].stdout='{"type":"agent_start"}\n';},
 'truncated-flag':(_o,c)=>{c[0].stdout_truncated=true;},'truncated-data':(_o,c)=>{c[0].stdout=c[0].stdout.slice(0,-6);},
 'timeout':(_o,c)=>{c[0].timed_out=true;},'interrupted':(_o,c)=>{c[0].interrupted=true;},
 'no-dispatch':(_o,c)=>{c[0].dispatched=false;},release:o=>{o[0].release='other';},evidence:o=>{o[0].evidence='';},
};
for(const [field,value] of [['evidence',{unexpected:'object'}],['evidence',42],['evidence',true],['evidence','   '],['verdict','unknown']] as const)corruptions[`shape-${field}-${JSON.stringify(value)}`]=(o)=>{(o[0] as any)[field]=value;};
for(const [field,value] of [['dispatched','true'],['dispatched',1],['exit_code','0'],['stdout_truncated',0],['stderr_truncated',''],['timed_out',null],['interrupted','false']] as const)corruptions[`capture-${field}`]=(_o,c)=>{(c[0] as any)[field]=value;};
for(const [name,change] of Object.entries(corruptions))test('reject '+name+' independently',()=>{
 const os=outcomes(),cs=captures(os);change(os,cs);
 // Identity/verdict changes also affect the actual terminal stream.
 if(!['malformed','absent-terminal','truncated-data'].includes(name))cs.forEach((c,i)=>{c.stdout=captures([os[i]])[0].stdout;});
 assert.throws(()=>validate(cs,identity,[...manifest.required],'release'));
 // Mutation must not relax shape/identity/stream guards (only success count).
 if(!['exit0-failed-verdict','nonzero-clean'].includes(name))assert.throws(()=>validate(cs,identity,[...manifest.required],'release',true));
 assert.throws(observation(os,cs));
});
test('non-string stdout and wrong initial event reject in both modes and observer',()=>{
 for(const stdout of [42,null,JSON.stringify({type:'wrong_start'})+'\n'+JSON.stringify({type:'fixture_terminal',outcome:outcomes()[0]})+'\n']){
 const os=outcomes(),cs=captures(os);(cs[0] as any).stdout=stdout;
 for(const mutation of [false,true])assert.throws(()=>validate(cs,identity,[...manifest.required],'release',mutation));
 assert.throws(observation(os,cs));
 }
});
test('A-B-A never revives original occurrence',()=>{
 const old=outcomes();old.forEach(o=>o.occurrence=0); // content A again, occurrence 2 expected
 assert.throws(()=>validate(captures(old),identity,[...manifest.required],'release'),/stale occurrence/);
 assert.throws(observation(old,captures(old)),/NoStaleAcceptance/);
});
test('missing review rejects even a clean promoted sink',()=>assert.throws(observation(outcomes(),captures(outcomes()),false),/MissingReview/));
test('only required-success mutation admits failed required batch; oracle rejects',()=>{
 const os=outcomes();os[0].verdict='failed';const cs=captures(os);cs[0].exit_code=7;
 assert.throws(()=>validate(cs,identity,[...manifest.required],'release'));
 assert.equal(validate(cs,identity,[...manifest.required],'release',true).length,2);
 assert.throws(observation(os,cs),/NoPrematureFanIn/);
});
test('dependency qualification rejects different version or bytes',()=>{
 const pins=JSON.parse(readFileSync(new URL('./pins.json',import.meta.url),'utf8'));
 assert.throws(()=>qualifiedInventory({...pins.inventory,digest:'different'},pins.inventory));
 assert.throws(()=>qualifiedInventory({...pins.inventory,distributions:[]},pins.inventory));
});
test('real CLI runner source pin mismatch rejects before any worker',async()=>{
 const source=dirname(new URL(import.meta.url).pathname);
 // Runner permits only direct children, so use its own separate private root.
 const target=output+'-wrong-pin';
 const r=await command(process.execPath,['--experimental-strip-types',join(source,'run.ts'),'--spec-kit',realpathSync(join(source,'../..')),'--output',target],source,{PATH:'/usr/bin:/bin'},15000);
 assert.notEqual(r.code,0);assert.match(r.text,/source pin\/cleanliness mismatch/);
 // There is no per-case directory before qualification completes.
 assert.throws(()=>readFileSync(join(target,'success/arrival-w0.json')));
});
for(const signal of ['SIGTERM','SIGINT'] as const)test('owned sleeping child killed on '+signal,async()=>{
 const root=join(output,signal);mkdirSync(root);
 const pidFile=join(root,'pid');const probe=join(root,'caller.ts');
 const common=new URL('./common.ts',import.meta.url).href;
 writeFileSync(probe,`import {command} from ${JSON.stringify(common)}; await command(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)}],${JSON.stringify(root)}, {},60000); require('node:fs').writeFileSync(${JSON.stringify(join(root,'continued'))},'bad');`);
 const caller=spawn(process.execPath,['--experimental-strip-types',probe],{stdio:'ignore'});
 const closed=new Promise(resolve=>caller.once('close',resolve));let pid:number|undefined;
 const live=(p:number)=>{try{return !/^State:\s*[ZX]/m.test(readFileSync(`/proc/${p}/status`,'utf8'));}catch{return false;}};
 try{
 const end=Date.now()+5000;while(!existsSync(pidFile)){if(Date.now()>end)throw Error('probe did not start');await new Promise(r=>setTimeout(r,20));}
 pid=Number(readFileSync(pidFile,'utf8'));assert.ok(live(pid));caller.kill(signal);await closed;
 // A short bounded scheduling grace for SIGKILL delivery, not natural completion (60s child bound).
 const deadline=Date.now()+1000;while(live(pid)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(live(pid),false);assert.equal(existsSync(join(root,'continued')),false);
 }finally{caller.kill('SIGKILL');if(!pid&&existsSync(pidFile))pid=Number(readFileSync(pidFile,'utf8'));if(pid)try{process.kill(-pid,'SIGKILL');}catch{}}
});
for(const bin of ['/usr/bin/false','/nonexistent-fixture-executable'])test('sequential launch failure is unexpected: '+bin,async()=>{
 const root=join(output,'broken-'+counter++);mkdirSync(root);
 let result;try{result=await command(bin,[],root,{},1000);}catch{result={code:1,text:'launch failed'};}
 assert.throws(()=>sequentialWitness(root,manifest,{status:'failed',step_results:{workers:{output:{results:[]}}}},result.code),/unexpected sequential failure/);
});
console.log('Private unit-test evidence: '+output);
