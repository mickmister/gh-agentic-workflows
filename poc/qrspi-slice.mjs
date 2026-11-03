#!/usr/bin/env node
// Deterministic QRSPI slice harness. This is NOT the Gas City runner.
// It is an independent checkpoint/approval oracle for the future Gas City integration.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [, , command, rootArg, ...args] = process.argv;
const root=path.resolve(rootArg || 'poc-state');
const file=path.join(root,'state.json');
const stages=['goals','design','tests','approval','implement','integrate'];
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function save(s){fs.mkdirSync(root,{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(s,null,2)+'\n');fs.renameSync(temp,file)}
function load(){return JSON.parse(fs.readFileSync(file,'utf8'))}
function ensure(c,msg){if(!c)throw Error(msg)}
function generate(s,stage,body){const p=path.join(root,'artifacts',stage+'.md');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);s.artifacts[stage]={path:'artifacts/'+stage+'.md',sha256:sha(body)};s.executionCounts[stage]=(s.executionCounts[stage]||0)+1;s.steps[stage]='completed'}
function init(){ensure(!fs.existsSync(file),'workspace already exists');save({schema:1,workspace:path.basename(root),runId:crypto.randomUUID(),revision:1,status:'ready',steps:Object.fromEntries(stages.map(x=>[x,'blocked'])),artifacts:{},executionCounts:{},history:[]})}
function start(){const s=load();ensure(s.status==='ready','start requires ready workspace');generate(s,'goals','# Goals\nImplement a pure greeting function.\n');s.steps.design='running';s.steps.tests='running';
// The two independent deterministic workers complete without touching a shared writable agent session.
generate(s,'design','# Design\nExport greet(name) from src/greet.mjs.\n');
generate(s,'tests','# Tests\nAssert greeting is deterministic.\n');
s.steps.approval='waiting';s.status='awaiting_approval';s.history.push({type:'checkpoint',revision:s.revision,at:new Date().toISOString()});save(s)}
function resume(){const s=load();const rev=Number(args[0]);const decision=args[1]||'approve';ensure(Number.isInteger(rev),'revision required');ensure(rev===s.revision,'stale revision');if(s.status==='completed'){ensure(decision==='approve'&&s.approval?.revision===rev,'completed workflow rejects new decision');return}
ensure(s.status==='awaiting_approval','workflow not waiting');ensure(['approve','request_changes'].includes(decision),'invalid decision');
for(const stage of ['goals','design','tests']){ensure(s.steps[stage]==='completed','prerequisite incomplete');const a=s.artifacts[stage];ensure(sha(fs.readFileSync(path.join(root,a.path)))===a.sha256,'artifact changed: '+stage)}
s.approval={revision:rev,decision,artifactHash:s.artifacts.design.sha256};s.steps.approval='completed';s.history.push({type:'decision',revision:rev,decision,at:new Date().toISOString()});
if(decision==='request_changes'){s.status='needs_revision';save(s);return}
generate(s,'implement','# Implementation\nExport greet(name) returning Hello, name.\n');
generate(s,'integrate','# Integration\nAll deterministic checks passed.\n');
s.status='completed';save(s)}
function inspect(){const s=load();for(const [stage,a] of Object.entries(s.artifacts)){ensure(sha(fs.readFileSync(path.join(root,a.path)))===a.sha256,'corrupt '+stage)}process.stdout.write(JSON.stringify(s,null,2)+'\n')}
try{switch(command){case 'init':init();break;case 'start':start();break;case 'resume':resume();break;case 'inspect':inspect();break;default:throw Error('usage: node poc/qrspi-slice.mjs <init|start|resume|inspect> <workspace-dir> [revision] [approve|request_changes]')}}catch(e){console.error(e.message);process.exitCode=1}
