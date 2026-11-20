import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {read} from './common.ts';
// Deliberately narrow native negative witness, not any nonzero engine exit.
export function sequentialWitness(root:string,m:any,native:any,code:number|null){
 const fail=()=>{throw Error('unexpected sequential failure: missing unreleased-barrier witness');};
 if(code===null||code===0||native.status!=='failed'||existsSync(join(root,'release.json'))||existsSync(join(root,'promotion.json'))||readdirSync(root).filter(p=>p.startsWith('arrival-')).join()!=='arrival-w0.json'||readdirSync(root).some(p=>p.startsWith('effect-')))fail();
 const arrival=read(join(root,'arrival-w0.json'));
 const receipt=existsSync(join(root,'barrier-timeout-w0.json'))?read(join(root,'barrier-timeout-w0.json')):null;
 const cs=native.step_results?.workers?.output?.results;
 if(!receipt||arrival.worker!=='w0'||JSON.stringify(arrival.identity)!==JSON.stringify(m.identity)||receipt.pid!==arrival.pid||receipt.worker!=='w0'||receipt.reason!=='unreleased-barrier'||receipt.release!==join(root,'release.json')||JSON.stringify(receipt.identity)!==JSON.stringify(m.identity)||!Array.isArray(cs)||cs.length!==1)fail();
 const c=cs[0];
 if(c.exit_code!==23||c.dispatched!==true||c.stdout!==''||typeof c.stderr!=='string'||['stdout_truncated','stderr_truncated','timed_out','interrupted'].some(k=>c[k]!==false))fail();
 let event;try{event=JSON.parse(c.stderr.trim());}catch{fail();}
 if(JSON.stringify(event)!==JSON.stringify({type:'fixture_barrier_timeout',...receipt}))fail();
 return {result:'barrier rejected',witness:'first worker arrived; native capture matches unreleased-barrier receipt'};
}
