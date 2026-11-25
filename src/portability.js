import { strToU8, strFromU8 } from 'fflate';
import { archive } from './archive.js';
import { z } from 'zod';
import { db } from './db.js';
import { DEFAULTS, PREFERENCES, STAGES, hash, httpUrl, nowISO, normalized, uid, validDate } from './domain.js';
import { detectSource } from './sources.js';
import { describeImport, findJob, recordEvent } from './tracker.js';

export const APP_HEADERS = ['application_id','company','job_title','job_id','job_url','role_category','seniority','location','work_mode','employment_type','sponsorship_status','priority','source','posted_at','first_seen_at','applied_at','resume_name','cover_letter_name','status','status_updated_at','notes'];
export const SOURCE_HEADERS = ['source_id','name','provider','url','interval','enabled','permitted'];
const columns = {
  Company:['company','employer','organization','organisation'],
  Title:['job_title','title','role','position','name'],
  URL:['job_url','url','job link','link','apply url'],
  Requisition:['job_id','req id','requisition','requisition id'],
  ID:['application_id','id'],
  Stage:['status','stage','application status'],
  Applied:['applied_at','applied date','date applied','application date'],
  Updated:['status_updated_at','status date','updated at'],
  Posted:['posted_at','posted date'],
  Seen:['first_seen_at','discovered date'],
  Notes:['notes','note','comments'],
  Location:['location'],
  Source:['source'],
  Resume:['resume_name','resume','résumé'],
  Cover:['cover_letter_name','cover letter'],
  Category:['role_category','category'],
  'Experience level':['seniority','experience level','level'],
  WorkMode:['work_mode','work mode'],
  Employment:['employment_type','employment type'],
  Sponsorship:['sponsorship_status','sponsorship status'],
  Priority:['priority']
};
const dangerousCell = /^[\s\uFEFF]*[=+\-@\t\r\n]/;
const encodeCell = value => {
  const raw = String(value ?? '');
  const safe = raw.startsWith("'") || dangerousCell.test(raw) ? "'"+raw : raw;
  return '"'+safe.replaceAll('"','""')+'"';
};
export const encodeCSV = (headers,rows)=>[headers.map(encodeCell).join(','),...rows.map(row=>headers.map(key=>encodeCell(row[key])).join(','))].join('\r\n')+'\r\n';
export function parseCSV(input,{unescape=false}={}) {
  const rows=[];
  let value='',cells=[],state='start';
  function pushValue() {
    cells.push(unescape && value.startsWith("'") && (value.startsWith("''") || dangerousCell.test(value.slice(1))) ? value.slice(1) : value);
    value='';state='start';
  }
  const content = input.replace(/^\uFEFF/,'');
  for (let i=0;i<content.length;i++) {
    const char=content[i];
    if (state==='quoted') {
      if (char==='"' && content[i+1]==='"') {value+='"';i++;}
      else if (char==='"') state='closed';
      else value+=char;
      continue;
    }
    if (char===',' || char==='\n'||char==='\r') {
      pushValue();
      if (char!==',') {
        if (cells.some(Boolean)) rows.push(cells);
        cells=[];
        if (char==='\r'&&content[i+1]==='\n') i++;
      }
      continue;
    }
    if (char==='"'&&state==='start') {state='quoted';continue;}
    if (state==='closed' || char==='"') throw new Error('CSV contains invalid field quoting.');
    value+=char;state='unquoted';
  }
  if (state==='quoted') throw new Error('CSV contains an unclosed quoted field.');
  if (value||cells.length||state==='closed') {pushValue();if(cells.some(Boolean)) rows.push(cells);}
  if (rows.length>25_001) throw new Error('Split the import into CSV files of up to 25,000 records.');
  return rows;
}
export function csvPreview(text,{mapping,unescape=false}={}) {
  const [head=[],...rows]=parseCSV(text,{unescape});
  if (!head.length || new Set(head).size!==head.length) throw new Error('CSV needs a header row with unique names.');
  mapping ??= Object.fromEntries(Object.entries(columns).map(([label,aliases])=>[
    label,head.find(value=>aliases.some(alias=>normalized(alias)===normalized(value)))??''
  ]));
  const entries=[],errors=[];
  const slots=new Map(head.map((value,index)=>[value,index]));
  rows.forEach((row,i)=>{
    try {
      if(row.length!==head.length) throw new Error('Column count does not match the header.');
      const get=key=>row[slots.get(mapping[key])]??'';
      const item=describeImport({company:get('Company'),title:get('Title'),url:get('URL'),requisition:get('Requisition'),location:get('Location'),
        source:get('Source'),roleCategory:get('Category'),seniority:get('Experience level'),workMode:get('WorkMode'),employmentType:get('Employment')});
      const checkDate=key=>{
        const val=get(key).trim();
        if (val && !Number.isFinite(Date.parse(val))) throw new Error(key+' has an invalid date.');
        return val ? new Date(val).toISOString() : null;
      };
      const rawStage=get('Stage').trim();
      const stage=STAGES.find(stage=>stage.toLowerCase()===rawStage.toLowerCase()) ?? (rawStage?null:'Saved');
      if (!stage) throw new Error('Unknown application stage "'+rawStage.slice(0,60)+'".');
      const applied=checkDate('Applied');
      entries.push({...item,id:get('ID').trim().slice(0,180),stage,notes:get('Notes').slice(0,24000),
        appliedAt:applied, updatedAt:checkDate('Updated'),postedAt:checkDate('Posted'),firstSeenAt:checkDate('Seen'),
        sponsorshipStatus:get('Sponsorship'),priority:get('Priority'),
        materials:{resume:get('Resume')?{name:get('Resume')}:null,cover:get('Cover')?{name:get('Cover')}:null}});
    } catch(error) {errors.push({row:i+2,error:error.message});}
  });
  return {head,mapping,entries,errors};
}
export async function importApplicationCSV(preview) {
  return db.transaction('rw',db.jobs,db.applications,db.events,async()=>{
    let added=0,duplicates=0;
    const errors=[...preview.errors];
    for (const [index,row] of preview.entries.entries()) {
      let job;
      try {job=await findJob(row.keys,row.urls);}
      catch(error){errors.push({row:index+2,error:error.message});continue;}
      if ((row.id&&await db.applications.get(row.id)) || (job&&await db.applications.where('jobId').equals(job.id).first())) {
        duplicates++;continue;
      }
      if (!job) {
        const {keys,urls,url,company,title,requisition,location,provider,attribution,roleCategory,seniority,workMode,employmentType,externalId,postedAt}=row;
        job={id:uid(),keys,urls,url,company,title,requisition,location,provider,attribution,roleCategory,seniority,workMode,employmentType,
          externalId,postedAt,firstSeenAt:row.firstSeenAt||nowISO(),active:false,official:false,members:{},sourceIds:[],manual:true};
        await db.jobs.add(job);
      }
      const id=row.id||uid(), at=row.firstSeenAt || row.appliedAt || row.updatedAt || nowISO();
      const app={id,jobId:job.id,company:row.company,title:row.title,url:row.url,requisition:row.requisition,location:row.location,
        source:row.attribution,notes:row.notes,createdAt:at,updatedAt:at,status:'Saved',submission:'unverified',materials:row.materials,
        roleCategory:row.roleCategory,seniority:row.seniority,workMode:row.workMode,employmentType:row.employmentType,
        sponsorshipStatus:row.sponsorshipStatus,priority:row.priority,postedAt:row.postedAt,firstSeenAt:row.firstSeenAt};
      await db.applications.add(app);
      if (row.appliedAt) await recordEvent({id:'csv-applied:'+id,applicationId:id,kind:'csv-confirmed',stage:'Applied',at:row.appliedAt});
      if (row.stage!=='Applied'||!row.appliedAt) {
        const date=row.updatedAt||row.appliedAt||at;
        await recordEvent({id:'csv-stage:'+id,applicationId:id,kind:row.stage==='Applied'?'csv-confirmed':'correction',stage:row.stage,at:date,dateInferred:!row.updatedAt&&!row.appliedAt});
      }
      added++;
    }
    return {added,duplicates,errors};
  });
}
export const applicationCSV = applications=>encodeCSV(APP_HEADERS,applications.map(app=>({
  application_id:app.id,company:app.company,job_title:app.title,job_id:app.requisition,job_url:app.url,role_category:app.roleCategory,
  seniority:app.seniority,location:app.location,work_mode:app.workMode,employment_type:app.employmentType,sponsorship_status:app.sponsorshipStatus,
  priority:app.priority,source:app.source,posted_at:app.postedAt,first_seen_at:app.firstSeenAt,applied_at:app.appliedAt,resume_name:app.materials?.resume?.name,
  cover_letter_name:app.materials?.cover?.name,status:app.status,status_updated_at:app.updatedAt,notes:app.notes
})));
export function eventsCSV(events) {
  const head=['event_id','application_id','message_id','at','stage','kind','category','subject','excerpt','url','urgent','deadline','timezone','acknowledged_at','resolved_at','reverses','note','duration_ms','resume_name','resume_revision','cover_letter_name','cover_letter_revision'];
  return encodeCSV(head,events.map(e=>({event_id:e.id,application_id:e.applicationId,message_id:e.messageId,at:e.at,stage:e.stage,kind:e.kind,category:e.category,
    subject:e.subject,excerpt:e.excerpt,url:e.url,urgent:e.urgent,deadline:e.deadline?.text,timezone:e.deadline?.timezone,
    acknowledged_at:e.acknowledgedAt,resolved_at:e.resolvedAt,reverses:e.reverses,note:e.note,duration_ms:e.duration,
    resume_name:e.materials?.resume?.name,resume_revision:e.materials?.resume?.revision,cover_letter_name:e.materials?.cover?.name,cover_letter_revision:e.materials?.cover?.revision})));
}
export function jobsCSV(jobs) {
  const header=['job_id','external_id','company','title','location','url','posted_at','first_seen_at','last_absent_at','updated_at','active','verified','match','sponsorship','sources'];
  return encodeCSV(header,jobs.map(j=>({job_id:j.id,external_id:j.externalId,company:j.company,title:j.title,location:j.location,url:j.url,
    posted_at:j.postedAt,first_seen_at:j.firstSeenAt,last_absent_at:j.lastAbsentAt,updated_at:j.updatedAt,active:j.active,verified:j.official,
    match:j.match?.score,sponsorship:j.sponsorship?.status,sources:j.sourceIds?.join(' | ')})));
}
export const sourcePack = sources=>sources.map(({id,name,provider,url,interval,enabled,permitted})=>({id,name,provider,url,interval,enabled,permitted}));
export const sourcesCSV = sources=>encodeCSV(SOURCE_HEADERS,sourcePack(sources).map(s=>({...s,source_id:s.id})));
export function readSources(text,{unescape=false}={}) {
  const input=text.trim();
  let rows;
  if (input.startsWith('{') || input.startsWith('[')) {
    const json=JSON.parse(input);
    rows=Array.isArray(json)?json:json.sources;
  } else if (input.split('\n')[0].includes(',')) {
    const [head,...lines]=parseCSV(input,{unescape});
    rows=lines.map(line=>Object.fromEntries(head.map((key,i)=>[key,line[i]])));
  } else rows=input.split('\n').map(url=>({url:url.trim()})).filter(row=>row.url);
  if (!Array.isArray(rows)||rows.length>160) throw new Error('Provide a source pack with at most 160 public URLs.');
  return rows.map(row=>{
    if(typeof row.url!=='string') throw new Error('A source is missing its URL.');
    const config=detectSource(row.url,row.provider);
    return {...config,name:String(row.name??config.name).slice(0,150),interval:Math.max(10,Math.min(1440,Math.round(Number(row.interval)||10))),
      enabled:row.enabled!==false && row.enabled!=='false',permitted:false};
  });
}

const listSetting=z.array(z.string().max(240)).max(100);
const cost=z.number().finite().min(0).max(10000);
const configSchema=z.object({
  preferences:z.object(Object.fromEntries(Object.entries(PREFERENCES).map(([name,value])=>[name,
    Array.isArray(value)?listSetting.optional():name==='minimumPay'?z.number().nonnegative().nullable().optional():
      typeof value==='boolean'?z.boolean().optional():typeof value==='number'?z.number().int().min(1).max(720).optional():z.string().max(60).optional()
  ]))).optional(),
  profile:z.object({
    ...Object.fromEntries(['givenName','familyName','fullName','preferredName','email','phone','phoneCountry','address1','address2','city','region','postal','country','linkedin','website','github','currentEmployer','currentTitle','summary'].map(key=>[key,z.string().max(12000).optional()])),
    skills:z.array(z.string().max(240)).max(500).optional(),
    education:z.array(z.object(Object.fromEntries(['school','degree','field','gpa','start','end'].map(key=>[key,z.string().max(500).optional()])))).max(80).optional(),
    experience:z.array(z.object({...Object.fromEntries(['employer','title','start','end','location','description'].map(key=>[key,z.string().max(12000).optional()])),current:z.boolean().optional()})).max(80).optional()
  }).optional(),
  onboarded:z.boolean().optional(),slots:z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).max(12).optional(),
  searchesPerRound:z.number().int().min(1).max(5).optional(),roundsPerDay:z.number().int().min(0).max(12).optional(),
  budget:cost.optional(),dailyBudget:cost.optional(),runBudget:cost.optional(),autoMatch:z.boolean().optional(),directAlerts:z.boolean().optional(),
  advance:z.boolean().optional(),model:z.string().max(100).optional(),draftModel:z.string().max(100).optional(),
  gmailDays:z.number().int().min(1).max(45).optional(),gmailFilter:z.string().max(180).optional(),mailAI:z.boolean().optional(),
  jdDays:z.number().int().min(1).max(3650).optional(),tombstoneDays:z.number().int().min(1).max(3650).optional(),
  defaultResume:z.string().max(180).optional(),defaultCover:z.string().max(180).optional()
});
export const portableConfig = config=>configSchema.parse(config);

const id=z.string().min(1).max(500);
const date=z.string().refine(validDate);
const publicLink=z.string().max(4000).refine(value=>!value||!!httpUrl(value));
const materialRef=z.object({id:id.optional(),name:z.string().max(254),revision:z.number().int().positive().optional(),hash:z.string().optional()});
const refs=z.object({resume:materialRef.nullable().optional(),cover:materialRef.nullable().optional()});
const textual=(keys,max=480)=>Object.fromEntries(keys.map(key=>[key,z.string().max(max).nullish()]));
const dates=keys=>Object.fromEntries(keys.map(key=>[key,date.nullish()]));
const status=z.enum(STAGES);
const tracking=z.object({
  id,jobId:id,company:z.string().min(1).max(240),title:z.string().min(1).max(300),url:publicLink.optional(),createdAt:date,updatedAt:date,
  ...dates(['firstSeenAt','appliedAt','postedAt']),status,submission:z.enum(['unverified','submitted','confirmed','needs_check']),
  ...textual(['requisition','location','source','roleCategory','seniority','workMode','employmentType','sponsorshipStatus','priority']),
  notes:z.string().max(24000).optional(),materials:refs.optional(),review:z.boolean().optional()
});
const event=z.object({
  id,applicationId:id.optional(),messageId:z.string().regex(/^[\w-]{1,150}$/).optional(),threadId:z.string().regex(/^[\w-]{1,150}$/).optional(),
  kind:z.string().min(1).max(80),stage:status.optional(),at:date,order:z.number().finite().optional(),url:publicLink.optional(),
  ...textual(['category','subject','excerpt','reverses','signature']),note:z.string().max(24000).optional(),duration:z.number().nonnegative().optional(),
  urgent:z.boolean().optional(),review:z.boolean().optional(),...dates(['acknowledgedAt','resolvedAt','notifiedAt','markedReadAt']),
  deadline:z.object({text:z.string().max(180),timezone:z.string().max(24).nullable()}).nullable().optional(),
  materials:refs.optional(),dateInferred:z.boolean().optional(),forceStage:z.boolean().optional()
});
const job=z.object({
  id,keys:z.array(z.string().max(4500)).max(100),urls:z.array(publicLink).max(100),url:publicLink,
  company:z.string().max(240),title:z.string().min(1).max(300),sourceIds:z.array(z.string().max(4500)).max(100),
  countries:listSetting.optional(),
  ...textual(['provider','externalId','requisition','location','locationDetails','workMode','employmentType','seniority','attribution','roleCategory','postingLabel','evidence','jdHash','matchKey'],500),
  ...dates(['postedAt','updatedAt','lastAbsentAt','closedAt','reopenedAt','notifiedAt','jdAt','jdUpdatedAt']),firstSeenAt:date,
  active:z.boolean(),official:z.boolean(),manual:z.boolean().optional(),lead:z.boolean().optional(),hidden:z.boolean().optional(),identityReview:z.boolean().optional(),
  jd:z.string().max(48_000).nullish(),members:z.record(z.string(),z.object({active:z.boolean(),key:z.string(),official:z.boolean().optional(),firstSeenAt:date.optional(),lastSeenAt:date.optional()})),
  dateEvidence:z.object({date:z.string(),kind:z.string().optional(),url:publicLink}).optional(),
  salary:z.object({min:z.number().nullable(),max:z.number().nullable(),currency:z.string(),period:z.string()}).nullish(),
  sponsorship:z.object({status:z.string(),items:z.array(z.object({status:z.string(),scope:z.string(),text:z.string().max(1500),url:publicLink.optional(),kind:z.string().optional(),date:z.string().optional()})).max(100)}).optional(),
  match:z.object({
    score:z.number().min(0).max(100),skills:z.number().min(0).max(100),experience:z.number().min(0).max(100),seniority:z.number().min(0).max(100),domain:z.number().min(0).max(100),
    strengths:z.array(z.string().max(400)).max(10),gaps:z.array(z.string().max(400)).max(10),confidence:z.string().max(30),resumeId:id.nullable(),coverId:id.nullable(),at:date,
    visaAssessment:z.object({status:z.string().max(40),refs:z.array(z.number().int()).max(100)}).optional()
  }).nullish(),
  userVisaEvidence:z.array(z.object({status:z.string(),scope:z.string(),text:z.string().max(1500),url:publicLink.optional(),kind:z.string(),date:z.string().optional()})).max(24).optional()
});
const answer=z.object({
  id,question:z.string().max(420),questionKey:z.string().max(420),scope:z.enum(['global','company','role']),context:z.string().max(240),
  type:z.string().max(40),value:z.string().max(6000),verified:z.literal(true),revision:z.number().int().positive(),updatedAt:date
});
const material=z.object({
  id,name:z.string().max(254),type:z.enum(['resume','cover']),label:z.string().max(200),tags:listSetting,text:z.string().max(150000),
  hash:z.string().regex(/^[a-f\d]{64}$/),revision:z.number().int().positive(),updatedAt:date
});
const source=z.object({id:id.optional(),url:publicLink,name:z.string().max(150),provider:z.string().max(40),interval:z.number().int().min(10).max(1440),enabled:z.boolean(),permitted:z.boolean().optional()});
const manifestSchema=z.object({format:z.literal('MeshJob'),version:z.literal(1),exportedAt:date,checksums:z.record(z.string(),z.string().regex(/^[a-f\d]{64}$/))});
const payloadSchema=z.object({settings:configSchema,sources:z.array(source),jobs:z.array(job),applications:z.array(tracking),events:z.array(event),answers:z.array(answer),materials:z.array(material)});
const dataTables=()=>[db.settings,db.sources,db.jobs,db.applications,db.events,db.answers,db.materials];
const uniqueIds=rows=>new Set(rows.map(row=>row.id)).size===rows.length;
function archiveAsync(operation,data) {
  if (typeof Worker==='undefined'||!globalThis.chrome?.runtime?.getURL) return Promise.resolve().then(()=>archive(operation,data));
  return new Promise((resolve,reject)=>{
    const worker=new Worker(chrome.runtime.getURL('archive-worker.js'));
    const complete=(fn,value)=>{clearTimeout(timer);worker.terminate();fn(value);};
    const timer=setTimeout(()=>complete(reject,new Error('Archive processing timed out.')),120_000);
    worker.onmessage=event=>event.data.ok?complete(resolve,event.data.result):complete(reject,new Error(event.data.error));
    worker.onerror=()=>complete(reject,new Error('The archive worker could not process this file.'));
    const buffers=data instanceof Uint8Array?[data.buffer]:Object.values(data).map(bytes=>bytes.buffer);
    worker.postMessage({operation,data},[...new Set(buffers)]);
  });
}
export async function makeBackup() {
  const snapshot=await db.transaction('r',dataTables(),async()=>{
    const [conf,sources,jobs,applications,events,answers,materials]=await Promise.all(dataTables().map(table=>table.toArray()));
    return {settings:conf[0]??{},sources:sourcePack(sources),jobs,applications,events,answers,materials};
  });
  const files={};
  for(const item of snapshot.materials) {
    const path='pdf/'+item.hash+'.pdf';
    if(!files[path]) files[path]=new Uint8Array(await item.blob.arrayBuffer());
  }
  const data=payloadSchema.parse(snapshot);
  files['records.json']=strToU8(JSON.stringify(data));
  const checksums=Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path,bytes])=>[path,await hash(bytes)])));
  files['manifest.json']=strToU8(JSON.stringify({format:'MeshJob',version:1,exportedAt:nowISO(),checksums}));
  return new Blob([await archiveAsync('zip',files)],{type:'application/zip'});
}

export async function previewBackup(file) {
  if (file.size>512_000_000) throw new Error('Backup exceeds the 512 MB import size limit.');
  const files=await archiveAsync('unzip',new Uint8Array(await file.arrayBuffer()));
  const manifest=manifestSchema.parse(JSON.parse(strFromU8(files['manifest.json']??new Uint8Array())));
  if (Object.keys(files).length!==Object.keys(manifest.checksums).length+1 || !manifest.checksums['records.json']) throw new Error('Backup files do not match the manifest.');
  for (const [path,checksum] of Object.entries(manifest.checksums)) {
    if (!files[path]||await hash(files[path])!==checksum) throw new Error('Backup checksum failed for '+path+'.');
  }
  const records=payloadSchema.parse(JSON.parse(strFromU8(files['records.json'])));
  if (!['jobs','applications','events','answers','materials'].every(key=>uniqueIds(records[key]))) throw new Error('Backup contains duplicate record IDs.');
  const jobs=new Set(records.jobs.map(row=>row.id)), apps=new Set(records.applications.map(row=>row.id));
  if (records.applications.some(row=>!jobs.has(row.jobId))||records.events.some(row=>row.applicationId&&!apps.has(row.applicationId))||
    new Set(records.applications.map(row=>row.jobId)).size!==records.applications.length) throw new Error('Backup contains inconsistent application links.');
  records.materials=await Promise.all(records.materials.map(async item=>{
    const bytes=files['pdf/'+item.hash+'.pdf'];
    if(!bytes||strFromU8(bytes.slice(0,5))!=='%PDF-'||await hash(bytes)!==item.hash) throw new Error('PDF content or checksum is invalid.');
    return {...item,blob:new Blob([bytes],{type:'application/pdf'})};
  }));
  return {manifest,records};
}

export async function restoreBackup(snapshot,mode) {
  if (!['merge','replace'].includes(mode)) throw new Error('Choose a restore mode.');
  const {records}=snapshot;
  const count={jobs:0,applications:0,events:0,sources:0,materials:0,answers:0};
  const sources=records.sources.map(raw=>({...detectSource(raw.url,raw.provider),name:raw.name,interval:raw.interval,enabled:false,permitted:false}));
  return db.transaction('rw',...dataTables(),db.runtime,db.usage,async()=>{
    if (mode==='replace') {
      await Promise.all([...dataTables().slice(1),db.runtime].map(table=>table.clear()));
      const current=await db.settings.get('settings');
      await db.settings.put({...DEFAULTS,...records.settings,id:'settings',mode:'Paused',generation:(current?.generation??0)+1});
    } else if (!await db.settings.get('settings')) {
      await db.settings.put({...DEFAULTS,...records.settings,id:'settings',mode:'Paused'});
    }
    const sourceIds=new Set(sources.map(row=>row.id));
    for (const source of sources) {
      if (await db.sources.get(source.id)) continue;
      await db.sources.add(source);count.sources++;
    }
    const mappedJobs=new Map(),mappedApps=new Map();
    for (const job of records.jobs) {
      const matched=await findJob(job.keys,job.urls);
      const old=await db.jobs.get(job.id);
      if (matched) {mappedJobs.set(job.id,matched.id);continue;}
      if (old && old.company===job.company && old.title===job.title && old.firstSeenAt===job.firstSeenAt && old.url===job.url) {
        mappedJobs.set(job.id,old.id);continue;
      }
      const mapped=old?uid():job.id;
      mappedJobs.set(job.id,mapped);
      await db.jobs.add({...job,id:mapped,sourceIds:job.sourceIds.filter(key=>sourceIds.has(key)),active:false,official:false});
      count.jobs++;
    }
    for (const app of records.applications) {
      const link=mappedJobs.get(app.jobId);
      const existing=await db.applications.where('jobId').equals(link).first();
      if (existing) {mappedApps.set(app.id,existing.id);continue;}
      const key=await db.applications.get(app.id)?uid():app.id;
      mappedApps.set(app.id,key);
      await db.applications.add({...app,id:key,jobId:link});count.applications++;
    }
    const mappedEvents=new Map();
    for (const event of records.events) {
      const existing=event.messageId?await db.events.where('messageId').equals(event.messageId).first():null;
      const old=await db.events.get(event.id);
      const applicationId=event.applicationId?mappedApps.get(event.applicationId):undefined;
      const same=old && old.applicationId===applicationId && old.kind===event.kind && old.at===event.at;
      mappedEvents.set(event.id,{id:existing?.id??(same?old.id:old?uid():event.id),skip:!!existing||same,applicationId});
    }
    for (const event of records.events.sort((a,b)=>(a.kind==='undo')-(b.kind==='undo'))) {
      const mapped=mappedEvents.get(event.id);
      if(mapped.skip) continue;
      const {skip,...identity}=mapped;
      const imported={...event,...identity,...(event.reverses?{reverses:mappedEvents.get(event.reverses)?.id??event.reverses}:{}),pendingRead:false};
      await recordEvent(imported);count.events++;
    }
    for (const [table,recordsKey] of [[db.answers,'answers'],[db.materials,'materials']]) {
      for(const row of records[recordsKey]) {
        const old=await table.get(row.id);
        if(old && (recordsKey==='answers'?old.questionKey===row.questionKey&&old.value===row.value&&old.context===row.context:old.hash===row.hash&&old.type===row.type)) continue;
        await table.add({...row,id:old?uid():row.id});count[recordsKey]++;
      }
    }
    return count;
  });
}
