#!/usr/bin/env node
// Disposable committed fixtures, not a real project's setup or coding acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {materialize} from './project-environment.mjs';
const [workspace, fixtureRoot] = process.argv.slice(2).map(p=>path.resolve(p));
fs.mkdirSync(fixtureRoot,{recursive:true});
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const write=(root,name,text)=>{const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
const repo=path.join(fixtureRoot,'config');fs.mkdirSync(repo);
git(repo,'init','-q','-b','main');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
const setup={name:'Fixture JS setup',description:'Exercise nested native actions, cache contract and retained cleanup slots',
  inputs:{recipe:{required:true,description:'Selected recipe'},'source-root':{required:true,description:'Source root'},'member-paths-file':{required:true,description:'Pinned member map'}},
  runs:{using:'composite',steps:[
    {uses:'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',with:{'node-version':'22'}},
    {id:'seed',uses:'./.engine/.github/actions/project-cache-restore',with:{spec:'${{ github.workspace }}/.agentic/cache-spec.json',members:'${{ inputs.member-paths-file }}','cache-root':'${{ github.workspace }}/.agentic/downloads',receipt:'${{ github.workspace }}/.agentic/cache-receipt.json',mode:'disabled'}},
    {name:'Build a clean fixture seed',shell:'bash',env:{MEMBERS:'${{ inputs.member-paths-file }}'},run:`node -e 'const fs=require("fs"),p=require("path"),m=JSON.parse(fs.readFileSync(process.env.MEMBERS));const d=p.join(m.app.directory,"node_modules","fixture");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"index.js"),"module.exports=42;");'`},
    {name:'Readiness on every path',shell:'bash',env:{MEMBERS:'${{ inputs.member-paths-file }}'},run:`node -e 'const fs=require("fs"),p=require("path"),m=JSON.parse(fs.readFileSync(process.env.MEMBERS));if(require(p.join(m.app.directory,"node_modules","fixture"))!==42)process.exit(1);'`},
    {uses:'./.engine/.github/actions/project-cache-save',with:{spec:'${{ github.workspace }}/.agentic/cache-spec.json',members:'${{ inputs.member-paths-file }}','cache-root':'${{ github.workspace }}/.agentic/downloads',receipt:'${{ github.workspace }}/.agentic/cache-receipt.json'}},
    {uses:'./.agentic/projects/demo/actions/post-probe'},
  ]}};
write(repo,'projects/demo/actions/setup/action.yml',JSON.stringify(setup,null,2));
write(repo,'projects/demo/actions/post-probe/action.yml',JSON.stringify({name:'Local cleanup probe',description:'Verifies delayed post action sees intact materialized files',runs:{using:'node24',main:'main.cjs',post:'post.cjs','post-if':'always()'}}));
write(repo,'projects/demo/actions/post-probe/main.cjs',`require('fs').writeFileSync(require('path').join(__dirname,'main-receipt.json'),'{}');console.log('PROJECT_MAIN_PROBE_OK');`);
write(repo,'projects/demo/actions/post-probe/post.cjs',`const fs=require('fs'),path=require('path');if(!fs.existsSync(path.join(__dirname,'main-receipt.json'))||!fs.existsSync(path.join(__dirname,'action.yml')))throw Error('materialized slot lost');console.log('PROJECT_POST_PROBE_OK');`);
write(repo,'.agentic/actions/setup/action.yml',JSON.stringify({name:'Read companion',description:'Second layout, same worker',
  inputs:{recipe:{required:true,description:'Recipe'},'source-root':{required:true,description:'Root'},'member-paths-file':{required:true,description:'Map'}},
  runs:{using:'composite',steps:[{shell:'bash',env:{MEMBERS:'${{ inputs.member-paths-file }}'},run:`node -e 'const fs=require("fs"),p=require("path"),m=JSON.parse(fs.readFileSync(process.env.MEMBERS));if(!fs.existsSync(p.join(m.contracts.directory,"lock.json")))process.exit(1);console.log("COMPANION_READINESS_OK");'`}]}}));
write(repo,'lock.json','{"fixture":1}\n');git(repo,'add','.');git(repo,'commit','-qm','committed setup fixtures');
const sha=git(repo,'rev-parse','HEAD');
git(repo,'checkout','-qb','project/companion');
git(repo,'rm','-qr','projects');
git(repo,'commit','-qm','separate companion configuration branch');
const companionSha=git(repo,'rev-parse','HEAD');
git(repo,'checkout','-q','main');
fs.mkdirSync(path.join(workspace,'sources'),{recursive:true});
const sources={};
for(const id of ['app','contracts']){sources[id]=path.join(workspace,'sources',id);execFileSync('git',['clone','-q','--no-hardlinks',repo,sources[id]]);}
const launch={schema:1,installation:'proof',projects:[
  {id:'demo',repository:'fixture/config',sha,path:'projects/demo',recipe:'js-checks',members:['app']},
  {id:'companion',repository:'fixture/config',sha:companionSha,path:'.agentic',recipe:'readiness',members:['contracts']},
],sources:['app','contracts'].map(id=>({id,repository:`fixture/${id}`,sha,access:id==='app'?'write':'read'}))};
const receipt=materialize(launch,workspace,{projects:{demo:repo,companion:repo},sources});
fs.writeFileSync(path.join(workspace,'.agentic/cache-spec.json'),JSON.stringify({schema:1,installation:'proof',project:'demo',recipe:'js-checks',environment:'linux-x64',generation:'1',class:'installed-seed',recipe_digest:receipt.projects[0].digest,runtime:{node:'22',os:'linux',arch:'x64'},inputs:[{member:'app',path:'lock.json'}],outputs:[{member:'app',path:'node_modules'}]}));
console.log(JSON.stringify(receipt));
