import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishCheckpoint} from './checkpoint-comment.ts';
const version='a'.repeat(40), snapshot='b'.repeat(40);
const env={GITHUB_REPOSITORY:'example/source',GITHUB_REF_NAME:'work/pilot',GITHUB_RUN_ID:'123',GH_TOKEN:'fixture',REVIEW_WORKSPACE:'workspace',QRSPI_PROCESS:'pilot',REVIEW_APP_URL:'https://example.github.io/app/',CHECKPOINT_VERSION:version,CHECKPOINT_SNAPSHOT:snapshot,CHECKPOINT_URL:`https://example.github.io/app/#/reviews/request-1?workspace=workspace&version=${version}&snapshot=${snapshot}`};
const pr={number:15,head:{ref:'work/pilot',repo:{full_name:'example/source'}},base:{repo:{full_name:'example/source'}}};
test('routes only to the source branch PR, finds paginated retries and ignores human markers',async()=>{
  const calls:{url:string,method:string,body?:string}[]=[];
  const marker=`<!-- qrspi-checkpoint:workspace:pilot:${version} -->\n`;
  const run=async(existing:boolean)=>publishCheckpoint(env,async(url,init)=>{
    calls.push({url,method:init!.method!,body:init?.body as string});
    if(url.includes('/pulls?'))return Response.json([pr,{...pr,number:16,head:{ref:'other',repo:{full_name:'example/source'}}}]);
    if(init?.method==='POST')return Response.json({html_url:'https://github.com/example/source/pull/15#issuecomment-1'});
    if(url.endsWith('page=1'))return Response.json(Array.from({length:100},()=>({user:{login:'human',type:'User'},body:marker})));
    return Response.json(existing?[{user:{login:'github-actions[bot]',type:'Bot'},body:marker+'existing',html_url:'existing-url'}]:[]);
  });
  const first=await run(false);
  assert.equal(first.state,'published');
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  const posted=JSON.parse(calls.find(c=>c.method==='POST')!.body!).body;
  assert.ok(posted.includes(env.CHECKPOINT_URL));
  assert.match(posted,/PR comments alone do not submit a review/);
  assert.ok(calls.some(c=>c.url.includes('head=example%3Awork%2Fpilot')));
  calls.length=0;
  assert.deepEqual(await run(true),{state:'already-published',url:'existing-url'});
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
});
test('no PR does not create an issue; ambiguous PRs and GitHub failures remain explicit',async()=>{
  assert.deepEqual(await publishCheckpoint(env,async()=>Response.json([])),{state:'no-open-pr'});
  await assert.rejects(publishCheckpoint(env,async()=>Response.json([pr,{...pr,number:16}])),/Multiple source PRs/);
  await assert.rejects(publishCheckpoint(env,async()=>new Response('private server detail',{status:403})),/GitHub HTTP 403/);
});
test('rejects cross-host, cross-workspace, missing and mismatched pins before API access',async()=>{
  for(const patch of [{CHECKPOINT_URL:env.CHECKPOINT_URL.replace('example.github.io','evil.invalid')},{REVIEW_WORKSPACE:'other'},{CHECKPOINT_VERSION:'c'.repeat(40)},{CHECKPOINT_SNAPSHOT:''}]){
    let calls=0;
    await assert.rejects(publishCheckpoint({...env,...patch},async()=>{calls++;return Response.json([]);}));
    assert.equal(calls,0);
  }
});
