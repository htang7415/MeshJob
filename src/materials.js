import { db } from './db.js';
import { hash, list, nowISO, trim, uid } from './domain.js';
import { fieldQuestion } from './form-rules.js';

async function readPdf(bytes,signal) {
  const pdf=await import(chrome.runtime.getURL('pdf-runtime.mjs'));
  pdf.GlobalWorkerOptions.workerSrc=chrome.runtime.getURL('pdf-worker.mjs');
  const task=pdf.getDocument({data:bytes.slice(),isEvalSupported:false,useWasm:false,disableFontFace:true,enableXfa:false,stopAtErrors:true});
  const stop=()=>void task.destroy().catch(()=>{});
  const timer=setTimeout(stop,15_000);
  signal?.addEventListener('abort',stop,{once:true});
  try {
    const document=await task.promise;
    let text='';
    for(let page=1;page<=document.numPages&&page<=100&&text.length<150000;page++) {
      signal?.throwIfAborted();
      const view=await document.getPage(page);
      const content=await view.getTextContent();
      text+=content.items.map(word=>word.str+(word.hasEOL?'\n':' ')).join('')+'\n';
      view.cleanup();
    }
    return text.trim().slice(0,150000);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',stop);
    await task.destroy().catch(()=>{});
  }
}
export async function storeMaterial({file,type,label,tags,text,id,signal}) {
  if (!['resume','cover'].includes(type)) throw new Error('Select a material type.');
  const old=id?await db.materials.get(id):null;
  if (!file&&!old) throw new Error('Choose a PDF.');
  const item={id:old?.id??uid(),type,label:trim(label).slice(0,200),tags:list(tags).slice(0,100).map(value=>value.slice(0,240)),
    revision:(old?.revision??0)+1,updatedAt:nowISO()};
  let warning;
  if (file) {
    if (!/\.pdf$/i.test(file.name)||file.type&&!['application/pdf','application/octet-stream'].includes(file.type)) throw new Error('Choose an original PDF file.');
    if (file.size>60_000_000) throw new Error('Choose a PDF smaller than 60 MB.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-') throw new Error('File does not have a PDF header.');
    item.name=file.name.replace(/[\/\\\0]/g,'_').slice(-254);
    item.hash=await hash(bytes);
    item.blob=new Blob([bytes],{type:'application/pdf'});
    if (!text) {
      try { text=await readPdf(bytes,signal); } catch { warning='Could not extract text. The original PDF is available for upload.'; }
      if (!text) warning ||= 'No extractable text. Add tags or text if you want matching assistance.';
    }
  } else Object.assign(item,{name:old.name,hash:old.hash,blob:old.blob});
  signal?.throwIfAborted();
  item.text=String(text ?? old?.text ?? '').slice(0,150000);
  item.label ||= item.name;
  await db.transaction('rw',db.materials,db.jobs,db.applications,async()=>{
    if(file&&old?.blob) {
      // Keep the exact PDF an application was sent with (spec 4, resume versions).
      const used=await db.applications.filter(app=>[app.materials?.resume,app.materials?.cover].some(ref=>ref?.id===old.id&&ref.revision===old.revision)).count();
      if(used) await db.materials.put({...old,id:old.id+'@'+old.revision,archived:true,parentId:old.id});
    }
    await db.materials.put(item);
    await db.jobs.filter(job=>!!job.matchKey).modify(job=>{delete job.matchKey;delete job.match;});
  });
  return {item,warning};
}
export async function saveAnswer(raw) {
  const old=raw.id?await db.answers.get(raw.id):null;
  const scope=old?.scope??'global';
  const answer={id:old?.id??uid(),question:trim(raw.question).slice(0,420),scope,context:old?.context??'',
    type:old?.type??'any',value:String(raw.value??'').trim().slice(0,6000),verified:true,
    revision:(old?.revision??0)+1,updatedAt:nowISO()};
  answer.questionKey=fieldQuestion(answer.question);
  if (!answer.questionKey||!answer.value) throw new Error('Enter a question and answer.');
  await db.answers.put(answer);
  return answer;
}

export async function removeMaterial(id) {
  await db.transaction('rw',db.materials,db.jobs,db.settings,async()=>{
    await db.materials.delete(id);
    const config=await db.settings.get('settings');
    if(config?.defaultResume===id) config.defaultResume='';
    if(config?.defaultCover===id) config.defaultCover='';
    if(config) await db.settings.put(config);
    await db.jobs.filter(job=>!!job.matchKey).modify(job=>{delete job.matchKey;delete job.match;});
  });
}

export const currentMaterials=rows=>rows.filter(row=>!row.archived);
export const versionLabel=ref=>ref?(ref.label||ref.name)+(ref.revision?' · v'+ref.revision:'')+(ref.external?' · External':''):'';
// The stored PDF for an application's reference: the current copy if the revision still matches, else the archived one.
export async function materialFor(ref) {
  if(!ref?.id) return null;
  const current=await db.materials.get(ref.id);
  if(current&&(!ref.revision||current.revision===ref.revision)) return current;
  return (await db.materials.get(ref.id+'@'+ref.revision))??null;
}
