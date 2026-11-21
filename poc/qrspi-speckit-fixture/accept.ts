#!/usr/bin/env -S node --experimental-strip-types
import {join} from 'node:path';
import {read,save,terminal} from './common.ts';
import type {Captured,Identity} from './common.ts';
export function validate(captures:Captured[],identity:Identity,required:string[],release:string,mutation=false){
 const outcomes=captures.map(terminal);
 if(outcomes.length!==required.length||new Set(outcomes.map(o=>o.worker)).size!==required.length)throw Error('required identities');
 for(const o of outcomes){if(!required.includes(o.worker)||o.release!==release||!o.evidence)throw Error('bad outcome');for(const k of Object.keys(identity) as (keyof Identity)[])if(o[k]!==identity[k])throw Error('stale '+k);}
 const clean=outcomes.filter((o,i)=>o.verdict==='clean'&&captures[i].exit_code===0).length;
 if(mutation?clean<1:clean!==required.length)throw Error('required-success guard');
 return outcomes;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const root=process.env.FIXTURE_CASE!;const m=read(join(root,'expected.json'));const action=process.argv[2];
 if(action==='validate'){
 const aggregate=JSON.parse(process.env.BATCH!);save(join(root,'aggregate.json'),aggregate);
 const captures=aggregate.results[0].results;
 const outcomes=validate(captures,m.identity,m.required,read(join(root,'release.json')).id,process.env.FIXTURE_MUTATION==='early-batch');
 save(join(root,'validated.json'),outcomes);
 }else if(action==='review')save(join(root,'review.json'),{outcomes:read(join(root,'validated.json'))});
 else if(action==='promote')save(join(root,'promotion.json'),{review:read(join(root,'review.json'))});
 else throw Error('unknown boundary');
}
