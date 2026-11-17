import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GetObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {analyzeNative,nativeSummary} from './analyze-native.ts';
import {target} from './inspect.ts';
import {digest} from './storage.ts';
const archive={role:'orchestrator',events:[{type:'text_delta',text:'SECRET-PROMPT'},{type:'arbitrary-private-text'}],result:{status:'completed'},text:JSON.stringify({question:'PRIVATE-QUESTION',artifacts:{'intake.md':'PRIVATE-BODY'}}),native:[JSON.stringify({type:'session',id:'private-session',timestamp:1000}),JSON.stringify({type:'message',timestamp:2500,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'PRIVATE-ANSWER'}],usage:{input:100,output:20,cacheRead:4,cost:{total:0.1}}}})]};
const env={NUGS_WORKSPACE_SEED:JSON.stringify({schema_version:1,workspace:'workspace',workspace_ref:'ws-'+'1'.repeat(32),engagement:'engagement',collection_id:'test',dolt_commit:'0'.repeat(32)}),REVIEW_WORKSPACE:'workspace',QRSPI_PROCESS:'pilot',BEAD_ID:'task-test',TARGET_RUN_ID:'123',TARGET_RUN_ATTEMPT:'1',S3_CACHE_BUCKET:'private',S3_CACHE_URL:'https://s3.invalid',S3_CACHE_ACCESS_KEY_ID:'private-key',S3_CACHE_SECRET_ACCESS_KEY:'private-secret'};
test('native counters retain useful performance/session evidence without raw bodies or invented parent links',()=>{
 const result=nativeSummary(archive);
 assert.equal(result.observedNativeDurationMs,1500);assert.equal(result.usage.inputTokens,100);assert.equal(result.nativeSessions.length,1);
 assert.equal(result.parentChildSessionLinksRecorded,false);assert.equal(result.phaseCompletionClaimed,false);
 assert.equal(result.events.other,1);assert.equal(result.authoredDocuments,1);
 assert.doesNotMatch(JSON.stringify(result),/SECRET-PROMPT|PRIVATE-QUESTION|PRIVATE-BODY|PRIVATE-ANSWER|private-session/);
});
test('inspection lists only bound run-prefix and GETs native evidence, never writes or dispatches',async()=>{
 const {binding}=target(env);
 const prefix=`qrspi/qrspi-hosted/processes/${digest(binding)}/private/123-1-`;
 const calls:string[]=[];
 const result=await analyzeNative(env,async command=>{calls.push(command.constructor.name);if(command instanceof ListObjectsV2Command){assert.equal(command.input.Prefix,prefix);return{Contents:[{Key:prefix+'orchestrator-11111111-1111-1111-1111-111111111111.json'}]};}assert.ok(command instanceof GetObjectCommand);return{Body:(async function*(){yield Buffer.from(JSON.stringify(archive));})()};});
 assert.deepEqual(calls,['ListObjectsV2Command','GetObjectCommand']);assert.equal(result.downloadedObjects,1);
 assert.doesNotMatch(JSON.stringify(result),/private-key|private-secret|PRIVATE-BODY/);
});
test('recorded tool-dispatched child links correlate with parent without leaking raw identities',()=>{
 const result=nativeSummary({...archive,role:'worker-reviewer',session:{id:'private-child',parentId:'private-parent',executionId:'123-1',toolCallId:'private-call',status:'completed',nativeSessionIds:['private-native']}});
 assert.equal(result.parentChildSessionLinksRecorded,true);
 assert.equal(result.session?.origin,'orchestrator-tool');
 assert.ok(result.session?.parentId);
 assert.doesNotMatch(JSON.stringify(result),/private-child|private-parent|private-call|private-native/);
});
test('invalid targets and out-of-prefix listings cannot read arbitrary objects; absent evidence remains absent',async()=>{
 let calls=0;
 await assert.rejects(analyzeNative({...env,TARGET_RUN_ID:'../other'},async()=>{calls++;return{};}));assert.equal(calls,0);
 await assert.rejects(analyzeNative(env,async command=>{calls++;assert.ok(command instanceof ListObjectsV2Command);return{Contents:[{Key:'other/private.json'}]};}),/Invalid native evidence listing/);
 assert.equal(calls,1);
 const result=await analyzeNative(env,async()=>({Contents:[]}));assert.equal(result.nativeEvidenceAvailable,false);assert.equal(result.downloadedObjects,0);
 const missing=nativeSummary({...archive,native:[]});assert.equal(missing.observedNativeDurationMs,null);assert.equal(missing.usage.reportedCost,null);
});
