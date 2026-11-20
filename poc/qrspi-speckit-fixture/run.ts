import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,readdirSync,chmodSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse,stringify} from 'yaml';
import {command,hash,save,read,wait} from './common.ts';
import {qualify} from './preflight.ts';
import {observe} from './history.ts';
import {sequentialWitness} from './sequential.ts';
process.umask(0o077);
const source=dirname(new URL(import.meta.url).pathname);
const args=process.argv.slice(2);const option=(s:string)=>args[args.indexOf(s)+1];
if(!args.includes('--spec-kit')||!args.includes('--output'))throw Error('explicit --spec-kit and --output required');
const upstream=option('--spec-kit'),output=option('--output');
const allowed='/var/lib/vd/scripts/vk/46e5-vd-multi-instanc/qrspi-speckit-fixture-impl-g1';
if(!isAbsolute(output)||dirname(output)!==allowed||realpathSync(allowed)!==allowed||existsSync(output))throw Error('output must be a new direct child of private output parent');
mkdirSync(output,{mode:0o700});
const env:NodeJS.ProcessEnv={PATH:dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',NO_COLOR:'1'};
save(join(output,'qualification.json'),await qualify(upstream,env));
const fixtureHashes=Object.fromEntries(readdirSync(source).filter(p=>p.endsWith('.ts')||p.endsWith('.json')).map(p=>[p,hash(readFileSync(join(source,p)))]));
save(join(output,'fixture-hashes.json'),fixtureHashes);
const results=[];
for(const name of ['success','continued-failure','halting-failure','sequential','sequential-broken','sequential-missing','invalid-yaml','invalid-reference','mutation']){
 const root=join(output,name);mkdirSync(root);for(const d of ['project/.specify','home','tmp'])mkdirSync(join(root,d),{recursive:true});
 const sequential=name.startsWith('sequential');
 const policy=name==='mutation'?'continued-failure':sequential?'success':name;
 const identity={task:'bounded-task',execution:randomUUID(),occurrence:2,content:hash('A'),attempt:1};
 const m=Object.freeze({identity:Object.freeze(identity),required:Object.freeze(['w0','w1']),policy});save(join(root,'expected.json'),m);chmodSync(join(root,'expected.json'),0o400);
 const authored=join(source,'workflows',`${['success','continued-failure','halting-failure'].includes(policy)?policy:'success'}.yaml`);
 let yaml=readFileSync(authored,'utf8');const d=parse(yaml);
 if(d.steps[0].max_concurrency!==2||JSON.stringify(d.steps[0].items)!=='["w0","w1"]'||JSON.stringify(d.steps[1].wait_for)!=='["workers"]')throw Error('unsupported fixture contract');
 const worker=d.steps[0].step;
 if(worker.command!=='speckit.fixture-worker'||worker.integration!=='pi'||worker.capture!==true||worker.capture_max_bytes!==8192||worker.timeout!==15||worker.input.args!=='{{ item }} {{ inputs.identity }}'||(worker.continue_on_error===true)!==(policy==='continued-failure'))throw Error('unsupported command contract');
 if(JSON.stringify(d.steps.slice(2).map((s:any)=>[s.id,s.type,s.strict,s.timeout]))!==JSON.stringify(['validate','review','promote'].map(id=>[id,'shell',true,10]))||d.steps[2].env.BATCH!=='{{ steps.batch.output | to_json }}')throw Error('unsupported acceptance path');
 let file=authored;
 if(sequential||name==='invalid-yaml'||name==='invalid-reference'){
 if(sequential)d.steps[0].max_concurrency=1;
 if(name==='invalid-reference')d.steps[1].wait_for=['missing'];
 yaml=name==='invalid-yaml'?'workflow: [broken':stringify(d);file=join(root,'variant.yaml');writeFileSync(file,yaml);
 }
 save(join(root,'definition.json'),{authored,executed:file,sha256:hash(yaml),mutation:name==='mutation'?'required-success: at-least-one':'none'});
 if(name==='mutation'){
 // Private replay copy records the exact single-guard configuration exercised.
 writeFileSync(join(root,'accept.ts'),readFileSync(join(source,'accept.ts')));
 writeFileSync(join(root,'common.ts'),readFileSync(join(source,'common.ts')));
 save(join(root,'mutation.json'),{environment:{FIXTURE_MUTATION:'early-batch'},guard:'mutation?clean<1:clean!==required.length'});
 }
 const childEnv={...env,HOME:join(root,'home'),TMPDIR:join(root,'tmp'),FIXTURE_CASE:root,FIXTURE_SOURCE:source,FIXTURE_MUTATION:name==='mutation'?'early-batch':'',SPECKIT_INTEGRATION_PI_EXECUTABLE:name==='sequential-broken'?'/usr/bin/false':name==='sequential-missing'?'/nonexistent-fixture-executable':join(source,'pi-double.ts'),SPECKIT_INTEGRATION_PI_EXTRA_ARGS:'--mode json'};
 const cli=join(upstream,'.venv/bin/specify'),project=join(root,'project');
 const add=await command(cli,['workflow','add','--dev',file],project,childEnv);writeFileSync(join(root,'add.log'),add.text);
 if(name.startsWith('invalid-')){if(add.code===0||m.required.some(w=>existsSync(join(root,`arrival-${w}.json`))))throw Error('invalid YAML/reference launched');results.push({name,result:'native preflight rejection'});continue;}
 if(add.code!==0)throw Error('native add failed: '+add.text);
 function find(p:string):string[]{return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?find(join(p,e.name)):[join(p,e.name)]);}
 if(!find(join(project,'.specify')).some(p=>readFileSync(p,'utf8')===yaml))throw Error('installed YAML differs');
 const running=command(cli,['workflow','run',file,'--input','identity='+JSON.stringify(identity),'--json'],project,childEnv);
 if(!sequential){
 await Promise.all(m.required.map(w=>wait(join(root,`arrival-${w}.json`),10000)));
 const arrivals=m.required.map(w=>read(join(root,`arrival-${w}.json`)));
 if(new Set(arrivals.map(a=>a.worker)).size!==2||m.required.some(w=>existsSync(join(root,`effect-${w}.json`))))throw Error('barrier evidence invalid');
 save(join(root,'release.json'),{id:randomUUID(),arrivals});
 if(name==='halting-failure'){
 await wait(join(root,'failure.json')); // failure has happened; sibling is held, not inferred from elapsed time
 if(existsSync(join(root,'effect-w1.json')))throw Error('late sibling escaped receipt');
 save(join(root,'allow-late.json'),{after:read(join(root,'failure.json'))});
 }
 }
 const run=await running;writeFileSync(join(root,'run.log'),run.text);
 // JSON CLI includes rich progress before the final object; native history is authoritative.
 const retained=find(join(project,'.specify/workflows/runs')).find(p=>p.endsWith('/workflow.yml'));
 if(!retained||JSON.stringify(parse(readFileSync(retained,'utf8')))!==JSON.stringify(parse(yaml)))throw Error('retained native definition differs');
 save(join(root,'retained-definition.json'),{path:retained,sha256:hash(readFileSync(retained)),equivalence:'parsed YAML; native serializer normalizes formatting'});
 const histories=find(join(project,'.specify')).filter(p=>p.endsWith('.json')).map(p=>({p,v:read(p)}));
 save(join(root,'native-index.json'),histories);
 const history=histories.find(x=>x.v.step_results?.workers)?.v;
 if(!history)throw Error('native history missing; inspect '+root);
 save(join(root,'native.json'),history);
 if(sequential){
 if(name==='sequential')results.push({name,...sequentialWitness(root,m,history,run.code)});
 else{
 let rejected=false;try{sequentialWitness(root,m,history,run.code);}catch(e){if(!(e instanceof Error)||!e.message.startsWith('unexpected sequential failure'))throw e;rejected=true;}
 if(!rejected||run.code===0||m.required.some(w=>existsSync(join(root,`arrival-${w}.json`))))throw Error('broken executable counted as barrier control');
 results.push({name,result:'unexpected launch failure correctly rejected; zero arrivals'});
 }
 continue;
 }
 let observed;try{observed=observe(root,m,history);}catch(e){if(name!=='mutation'||!(e instanceof Error)||e.message!=='NoPrematureFanIn')throw e;observed={promoted:true,detected:'NoPrematureFanIn'};}
 if(name==='success'&&!observed.promoted)throw Error('positive unreachable');
 if(name==='mutation'&&(!observed.promoted||!('detected' in observed)))throw Error('mutation not killed');
 if(['continued-failure','halting-failure'].includes(name)&&observed.promoted)throw Error('bad promotion');
 if(name==='continued-failure'&&!existsSync(join(root,'aggregate.json')))throw Error('continued failure did not reach fan-in');
 if(name==='halting-failure'){
 if(history.step_results.workers.output.results.length!==1||history.step_results.workers.output.results[0].exit_code!==7||!existsSync(join(root,'effect-w1.json'))||existsSync(join(root,'aggregate.json')))throw Error('halting partial/late contract');
 }
 results.push({name,code:run.code,...observed});
}
const fizz=process.env.FIZZBEE_ROOT;if(!fizz||!isAbsolute(fizz))throw Error('explicit FIZZBEE_ROOT required');
for(const d of ['model-home','model-tmp'])mkdirSync(join(output,d));
const model=await command(process.execPath,['--experimental-strip-types',join(source,'../qrspi-fizzbee/check.ts'),'mutation-early-batch'],output,{...env,HOME:join(output,'model-home'),TMPDIR:join(output,'model-tmp'),FIZZBEE_ROOT:fizz,FIZZBEE_RESULTS:join(output,'model')},90000);
writeFileSync(join(output,'model.log'),model.text);if(model.code!==0)throw Error('model mutation failed: '+model.text);
save(join(output,'summary.json'),results);console.log(JSON.stringify({output,results},null,2));
