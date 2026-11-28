import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
export const hash=(s: string|Buffer)=>createHash('sha256').update(s).digest('hex');
export const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
export const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
export const wait=async(p:string,ms=8000)=>{const end=Date.now()+ms; while(!existsSync(p)){if(Date.now()>end)throw Error('barrier/receipt timeout: '+p); await new Promise(r=>setTimeout(r,20));}};
const owned=new Set<number>();
let interrupted=false;
const killGroup=(pid:number)=>{try{process.kill(-pid,'SIGKILL');}catch{}};
const cleanup=()=>{for(const pid of owned)killGroup(pid);};
// Synchronous kill on exit also covers uncaught errors. Signals terminate the caller:
// no continuation can dispatch the next case after interruption.
process.once('exit',cleanup);
for(const [signal,code] of [['SIGTERM',143],['SIGINT',130]] as const)process.once(signal,()=>{interrupted=true;cleanup();process.exit(code);});
export function command(bin:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,ms=30000){
 if(interrupted)throw Error('runner interrupted');
 return new Promise<{code:number|null,text:string}>((resolve,reject)=>{
 const child=spawn(bin,args,{cwd,env,detached:true}); let text='';let killed=false;
 if(child.pid)owned.add(child.pid);
 const kill=()=>{killed=true;if(child.pid)killGroup(child.pid);};
 const timer=setTimeout(kill,ms);
 for(const s of [child.stdout,child.stderr])s.on('data',(b:Buffer)=>{text+=b.toString();if(Buffer.byteLength(text)>4*1024*1024)kill();});
 child.on('error',e=>{kill();clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(child.pid){killGroup(child.pid);owned.delete(child.pid);}if(killed)reject(Error('bounded subprocess exceeded limit'));else resolve({code,text});});
 });
}
export type Identity={task:string;execution:string;occurrence:number;content:string;attempt:number};
export type Outcome=Identity & {worker:string;verdict:string;release:string;evidence:string};
export type Captured={exit_code:number;dispatched:boolean;stdout:string;stdout_truncated?:boolean;stderr_truncated?:boolean;timed_out?:boolean;interrupted?:boolean};
export function terminal(c:Captured):Outcome{
 if(!c||typeof c!=='object'||!Number.isInteger(c.exit_code)||c.dispatched!==true||typeof c.stdout!=='string'||['stdout_truncated','stderr_truncated','timed_out','interrupted'].some(k=>{const v=c[k as keyof Captured];return v!==undefined&&v!==false;})||!c.stdout.endsWith('\n'))throw Error('invalid capture');
 const events=c.stdout.trim().split('\n').map(x=>JSON.parse(x));
 if(events.length!==2||events[0].type!=='agent_start'||events[1].type!=='fixture_terminal')throw Error('invalid terminal stream');
 const o=events[1].outcome;
 if(!o||typeof o!=='object'||['task','execution','content','worker','release','evidence'].some(k=>typeof o[k]!=='string'||!o[k].trim())||!Number.isInteger(o.occurrence)||o.occurrence<0||!Number.isInteger(o.attempt)||o.attempt<1||!['clean','failed'].includes(o.verdict))throw Error('invalid outcome shape');
 return o;
}
