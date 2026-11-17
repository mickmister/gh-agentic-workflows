import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {S3Client, GetObjectCommand, ListObjectsV2Command} from '@aws-sdk/client-s3';
import {target} from './inspect.ts';
import {digest} from './storage.ts';
import {assert} from './core.ts';
import {classify} from './diagnostics.ts';

type ReadCommand=GetObjectCommand|ListObjectsV2Command;
const sha=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
/** Parse private evidence without emitting prompts, output text, log bodies or arbitrary attributes. */
export function nativeSummary(value:any) {
  assert(value && Array.isArray(value.events) && Array.isArray(value.native),'Invalid native archive');
  const events:Record<string,number>={}, stops:Record<string,number>={};
  const eventTypes=new Set(['text_delta','thought_delta','tool_call','tool_result','session_started','turn_started','turn_completed','status','error']);
  for(const event of value.events){const type=eventTypes.has(event?.type)?event.type:'other';events[type]=(events[type]??0)+1;}
  const sessions=new Set<string>(), times:number[]=[];
  let assistantMessages=0,toolCalls=0,inputTokens=0,outputTokens=0,cacheReadTokens=0,cacheWriteTokens=0,cost=0,invalidLines=0,usageRecords=0,costReported=false;
  for(const line of value.native){
    let row:any;try{row=JSON.parse(line);}catch{invalidLines++;continue;}
    if(!row||typeof row!=='object'){invalidLines++;continue;}
    if(row.type==='session'&&typeof row.id==='string')sessions.add(sha(row.id).slice(0,16));
    const timestamp=typeof row.timestamp==='number'?row.timestamp:Date.parse(row.timestamp);
    if(Number.isFinite(timestamp))times.push(timestamp);
    const message=row.message;
    if(row.type!=='message'||message?.role!=='assistant')continue;
    assistantMessages++;
    const stop=['stop','error','aborted','length','toolUse'].includes(message.stopReason)?message.stopReason:'unknown';
    stops[stop]=(stops[stop]??0)+1;
    toolCalls+=Array.isArray(message.content)?message.content.filter((item:any)=>['toolCall','tool_use'].includes(item?.type)).length:0;
    if(message.usage&&typeof message.usage==='object')usageRecords++;
    inputTokens+=count(message.usage?.input);outputTokens+=count(message.usage?.output);
    cacheReadTokens+=count(message.usage?.cacheRead);cacheWriteTokens+=count(message.usage?.cacheWrite);cost+=count(message.usage?.cost?.total);costReported ||= typeof message.usage?.cost?.total==='number';
  }
  let authoredDocuments=0,questionHash:string|undefined;
  try{const output=JSON.parse(value.text);authoredDocuments=output?.artifacts&&typeof output.artifacts==='object'?Object.keys(output.artifacts).length:0;if(typeof output?.question==='string')questionHash=sha(output.question);}catch{/* Not every role returns structured authored output. */}
  return {role:['preparation','setup-planner','orchestrator','approval-consistency','questions-author','review-quality','review-scope','exit-interview'].includes(value.role)?value.role:'other',
    resultStatus:['completed','failed','cancelled','timed_out'].includes(value.result?.status)?value.result.status:'unknown',failurePresent:Boolean(value.failure),
    events,nativeLines:value.native.length,invalidLines,nativeSessions:[...sessions],assistantMessages,toolCalls,nativeStopReasons:stops,
    observedNativeDurationMs:times.length>1?times.reduce((a,b)=>Math.max(a,b))-times.reduce((a,b)=>Math.min(a,b)):null,
    usage:{records:usageRecords,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reportedCost:costReported?cost:null},authoredDocuments,questionHash,
    parentChildSessionLinksRecorded:false,phaseCompletionClaimed:false};
}

/** LIST/GET only, restricted to an exact bound process and target Actions attempt. */
export async function analyzeNative(env:NodeJS.ProcessEnv,send?:(command:ReadCommand)=>Promise<any>){
  const {binding}=target(env);
  assert(env.S3_CACHE_BUCKET&&env.S3_CACHE_URL&&env.S3_CACHE_ACCESS_KEY_ID&&env.S3_CACHE_SECRET_ACCESS_KEY,'Missing private S3 configuration');
  const client=send?undefined:new S3Client({endpoint:env.S3_CACHE_URL,region:env.S3_CACHE_REGION??'us-east-1',forcePathStyle:env.S3_CACHE_PATH_STYLE==='true',
    credentials:{accessKeyId:env.S3_CACHE_ACCESS_KEY_ID,secretAccessKey:env.S3_CACHE_SECRET_ACCESS_KEY},maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const read=send??((command:ReadCommand)=>client!.send(command as GetObjectCommand));
  const prefix=(env.S3_CACHE_PREFIX??'qrspi').replace(/^\/+|\/+$/g,'')+'/qrspi-hosted/';
  const privatePrefix=`${prefix}processes/${digest(binding)}/private/`;
  const runPrefix=`${env.TARGET_RUN_ID}-${env.TARGET_RUN_ATTEMPT??'1'}-`;
  const records:unknown[]=[];let bytes=0;
  try{
    let token:string|undefined;
    for(let page=0;page<5;page++){
      const list=await read(new ListObjectsV2Command({Bucket:env.S3_CACHE_BUCKET,Prefix:privatePrefix+runPrefix,MaxKeys:100,...(token?{ContinuationToken:token}:{})}));
      for(const item of list.Contents??[]){
        assert(typeof item.Key==='string'&&item.Key.startsWith(privatePrefix+runPrefix),'Invalid native evidence listing');
        const suffix=item.Key.slice((privatePrefix+runPrefix).length);
        assert(/^[a-z][a-z0-9-]{0,60}-[a-f0-9-]{36}\.json$/.test(suffix),'Invalid native evidence name');
        assert(records.length<32,'Native evidence object count exceeded');
        const response=await read(new GetObjectCommand({Bucket:env.S3_CACHE_BUCKET,Key:item.Key}));
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of response.Body as AsyncIterable<Uint8Array>){size+=chunk.byteLength;bytes+=chunk.byteLength;assert(size<=32_000_000&&bytes<=128_000_000,'Native evidence bytes exceeded');chunks.push(Buffer.from(chunk));}
        const body=Buffer.concat(chunks);
        records.push({archiveHash:sha(body),bytes:size,...nativeSummary(JSON.parse(body.toString('utf8')))});
      }
      if(!list.IsTruncated)break;
      assert(typeof list.NextContinuationToken==='string'&&page<4,'Native evidence listing truncated');token=list.NextContinuationToken;
    }
    return {diagnosticOnly:true,run:env.TARGET_RUN_ID,attempt:env.TARGET_RUN_ATTEMPT??'1',downloadedObjects:records.length,downloadedBytes:bytes,records,
      nativeEvidenceAvailable:records.length>0,otelDecoded:false,notice:records.length?'Native evidence was downloaded and inspected. These are host-scheduled role sessions, not proof of orchestrator-created child sessions or completed QRSPI phases. No process work was admitted.':'No native archives found for this target. This is not evidence of success, zero usage, or permission to replay process work.'};
  }finally{client?.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await analyzeNative(process.env)));}
  catch(error){console.error(JSON.stringify({notice:'Native evidence inspection unavailable; no process work executed and no replay authorized.',failure:classify(error)}));process.exitCode=1;}
}
