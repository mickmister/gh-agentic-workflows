import {readdirSync,readFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {command,hash,read} from './common.ts';
export function inventory(root:string){
 const base=join(root,'.venv/lib/python3.11/site-packages'); const files:Record<string,string>={};
 function walk(dir:string){for(const n of readdirSync(join(base,dir)).sort()){if(n==='__pycache__'||n.endsWith('.pyc'))continue;const p=join(dir,n);const st=lstatSync(join(base,p));if(st.isSymbolicLink())throw Error('unexpected dependency symlink');if(st.isDirectory())walk(p);else files[p]=hash(readFileSync(join(base,p)));}}
 walk(''); return {digest:hash(JSON.stringify(files)),distributions:readdirSync(base).filter(x=>x.endsWith('.dist-info')).sort(),files: Object.keys(files).length};
}
export function qualifiedInventory(actual:unknown,expected:unknown){
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('unqualified installed dependency inventory');
}
export async function qualify(root:string,env:NodeJS.ProcessEnv){
 if(!isAbsolute(root)||realpathSync(root)!==root)throw Error('explicit canonical absolute Spec Kit root required');
 const pins=read(new URL('./pins.json',import.meta.url).pathname);
 const git=async(args:string[])=>(await command('/usr/bin/git',args,root,env)).text.trim();
 if(await git(['rev-parse','HEAD'])!==pins.source||await git(['status','--porcelain','--untracked-files=all'])!=='')throw Error('source pin/cleanliness mismatch');
 if(process.version!==pins.node)throw Error('Node pin mismatch');
 qualifiedInventory(inventory(root),pins.inventory);
 if(realpathSync(join(root,'.venv/bin/python'))!==pins.pythonExecutable||hash(readFileSync(pins.pythonExecutable))!==pins.pythonExecutableSha256)throw Error('unqualified Python executable');
 const config=readFileSync(join(root,'.venv/pyvenv.cfg'),'utf8');
 if(!config.includes('include-system-site-packages = false'))throw Error('system site packages enabled');
 const p=await command(join(root,'.venv/bin/python'),['-I','-c','import specify_cli,sys,importlib.metadata as m; print(specify_cli.__file__); print(sys.version.split()[0]); print(m.version("specify-cli"))'],root,env);
 if(p.code!==0||p.text.trim()!==`${root}/src/specify_cli/__init__.py\n${pins.python}\n1.4.3`)throw Error('import/version provenance mismatch: '+p.text);
 const version=await command(join(root,'.venv/bin/specify'),['--version'],root,env);
 if(version.code!==0||!version.text.includes('1.4.3'))throw Error('CLI version mismatch');
 if(hash(readFileSync(join(root,'.venv/bin/specify')))!==pins.launcher)throw Error('unqualified CLI launcher');
 return {pins,provenance:p.text,version:version.text};
}
