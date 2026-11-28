import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {read} from './common.ts';
// Independent oracle uses immutable driver expectations and sink/native captures,
// never calls the implementation's validate predicate.
export function observe(root:string,m:any,native:any){
 const promoted=existsSync(join(root,'promotion.json'));
 if(promoted){
 if(!existsSync(join(root,'review.json')))throw Error('MissingReview');
 const promotion=read(join(root,'promotion.json'));
 const review=read(join(root,'review.json'));
 if(JSON.stringify(review)!==JSON.stringify(promotion.review))throw Error('ReviewMismatch');
 if(!existsSync(join(root,'validated.json'))||JSON.stringify(read(join(root,'validated.json')))!==JSON.stringify(review.outcomes))throw Error('MissingValidation');
 const sink=promotion.review.outcomes;
 const workers=native.step_results.workers.output.results;
 if(sink.length!==m.required.length||workers.length!==m.required.length)throw Error('NoPrematureFanIn');
 for(const w of m.required){
 const matching=sink.filter((o:any)=>o.worker===w);
 if(matching.length!==1)throw Error('NoPrematureFanIn');const o=matching[0];
 for(const k of Object.keys(m.identity))if(o[k]!==m.identity[k])throw Error('NoStaleAcceptance');
 if(['task','execution','content','worker','release','evidence'].some(k=>typeof o[k]!=='string'||o[k].trim().length===0)||!Number.isInteger(o.occurrence)||o.occurrence<0||!Number.isInteger(o.attempt)||o.attempt<1||o.verdict!=='clean')throw Error('NoPrematureFanIn');
 const item={output:workers[m.required.indexOf(w)]};
 if(item.output.exit_code!==0||item.output.dispatched!==true||typeof item.output.stdout!=='string'||['stdout_truncated','stderr_truncated','timed_out','interrupted'].some(k=>item.output[k]!==undefined&&item.output[k]!==false)||!item.output.stdout.endsWith('\n'))throw Error('NoPrematureFanIn');
 const lines=item.output.stdout.trim().split('\n').map((x:string)=>JSON.parse(x));
 if(lines.length!==2||lines[0].type!=='agent_start'||lines[1].type!=='fixture_terminal'||JSON.stringify(lines[1].outcome)!==JSON.stringify(o))throw Error('InvalidTerminal');
 const release=read(join(root,'release.json'));
 if(o.release!==release.id||release.arrivals.length!==2||new Set(release.arrivals.map((a:any)=>a.worker)).size!==2)throw Error('BarrierCausality');
 if(JSON.stringify(read(join(root,`effect-${w}.json`)))!==JSON.stringify(o))throw Error('SinkMismatch');
 }
 }
 return {promoted};
}
