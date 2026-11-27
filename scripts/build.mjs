import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { ATS_ORIGINS, LIST_ORIGINS } from '../src/domain.js';

const root=new URL('../',import.meta.url);
const path=name=>new URL(name,root);
const {version}=JSON.parse(await readFile(path('package.json'),'utf8'));
const key=process.env.MESHJOB_EXTENSION_PUBLIC_KEY || (await readFile(path('scripts/extension-public-key.txt'),'utf8')).trim();
if(!/^[A-Za-z0-9+/]+=*$/.test(key)) throw new Error('Provide a base64 extension public key.');
const out=resolve(process.env.MESHJOB_DIST||fileURLToPath(path('dist')));
await mkdir(out,{recursive:true});
await cp(path('assets'),out,{recursive:true});
await Promise.all([
  build({absWorkingDir:fileURLToPath(root),entryPoints:['src/background.js','src/dashboard.js','src/panel.js','src/content.js','src/archive-worker.js'],outdir:out,bundle:true,
    format:'iife',platform:'browser',target:'chrome120',minify:true,legalComments:'linked',charset:'utf8',logLevel:'info'}),
  copyFile(path('node_modules/pdfjs-dist/build/pdf.min.mjs'),resolve(out,'pdf-runtime.mjs')),
  copyFile(path('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),resolve(out,'pdf-worker.mjs')),
  copyFile(path('node_modules/pdfjs-dist/LICENSE'),resolve(out,'PDFJS-LICENSE')),
  copyFile(path('LICENSE'),resolve(out,'LICENSE'))
]);
const licensePackages=['dexie','fflate','htmlparser2','dom-serializer','domelementtype','domhandler','domutils','entities','zod'];
const notices=await Promise.all(licensePackages.map(async name=>{
  const directory=path('node_modules/'+name+'/');
  const found=(await readdir(directory)).find(file=>/^licen[cs]e(?:\.|$)/i.test(file));
  if(!found) throw new Error('Missing third-party license for '+name);
  const info=JSON.parse(await readFile(new URL('package.json',directory),'utf8'));
  return name+' '+info.version+'\n\n'+(await readFile(new URL(found,directory),'utf8')).trim();
}));
await writeFile(resolve(out,'THIRD_PARTY_NOTICES.txt'),notices.join('\n\n'+('-'.repeat(72))+'\n\n')+'\n');
const manifest={
  manifest_version:3,name:'MeshJob',version,key,description:'Find jobs early, fill applications accurately, and track your search locally.',
  minimum_chrome_version:'120',permissions:['activeTab','scripting','storage','alarms','notifications','sidePanel','declarativeContent'],
  optional_permissions:['identity','webNavigation'],optional_host_permissions:['https://*/*'],
  host_permissions:[...ATS_ORIGINS,...LIST_ORIGINS],
  action:{default_title:'Open MeshJob',default_icon:{16:'icons/icon16.png',32:'icons/icon32.png'}},
  icons:{16:'icons/icon16.png',32:'icons/icon32.png',48:'icons/icon48.png',128:'icons/icon128.png'},
  background:{service_worker:'background.js'},side_panel:{default_path:'panel.html'},
  commands:{_execute_action:{suggested_key:{default:'Alt+Shift+M'},description:'Open MeshJob beside the page'},
    'open-full-view':{suggested_key:{default:'Alt+Shift+F'},description:'Open MeshJob full view'}},
  content_security_policy:{extension_pages:"script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}
};
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(process.env.MESHJOB_ZIP) {
  async function collect(directory,prefix='') {
    const entries=await readdir(directory,{withFileTypes:true});
    const flat={};
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const file=resolve(directory,entry.name),name=prefix+entry.name;
      if(entry.isDirectory()) Object.assign(flat,await collect(file,name+'/'));
      else flat[name]=[new Uint8Array(await readFile(file)),{mtime:new Date(1980,0,1)}];
    }
    return flat;
  }
  await writeFile(resolve(process.env.MESHJOB_ZIP),zipSync(await collect(out),{level:9}));
}
