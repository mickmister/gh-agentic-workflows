import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const script=new URL('./qrspi-slice.mjs',import.meta.url).pathname;
function cmd(root,...args){return spawnSync(process.execPath,[script,...args.slice(0,1),root,...args.slice(1)],{encoding:'utf8'})}
test('durable checkpoint, independent process resume, and idempotency',()=>{
const r=fs.mkdtempSync(path.join(os.tmpdir(),'qrspi-test-'));
try{
assert.equal(cmd(r,'init').status,0);
assert.equal(cmd(r,'start').status,0);
const before=JSON.parse(fs.readFileSync(path.join(r,'state.json')));assert.equal(before.status,'awaiting_approval');
assert.equal(before.steps.implement,'blocked');
assert.notEqual(cmd(r,'resume','999','approve').status,0);
assert.equal(cmd(r,'resume','1','approve').status,0);
assert.equal(cmd(r,'resume','1','approve').status,0);
const after=JSON.parse(fs.readFileSync(path.join(r,'state.json')));
assert.equal(after.runId,before.runId);assert.equal(after.status,'completed');
assert.deepEqual(after.executionCounts,{goals:1,design:1,tests:1,implement:1,integrate:1});
assert.equal(cmd(r,'inspect').status,0);
}finally{fs.rmSync(r,{recursive:true,force:true})}
});
test('independent feature directories cannot interfere',()=>{
const a=fs.mkdtempSync(path.join(os.tmpdir(),'qrspi-a-'));const b=fs.mkdtempSync(path.join(os.tmpdir(),'qrspi-b-'));
try{for(const p of [a,b]){assert.equal(cmd(p,'init').status,0);assert.equal(cmd(p,'start').status,0)}
assert.equal(cmd(a,'resume','1','approve').status,0);
assert.equal(JSON.parse(fs.readFileSync(path.join(b,'state.json'))).status,'awaiting_approval');
}finally{fs.rmSync(a,{recursive:true,force:true});fs.rmSync(b,{recursive:true,force:true})}
});
