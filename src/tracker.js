import { db, guarded } from './db.js';
import { canonicalUrl, httpUrl, JOB_DESCRIPTION_LIMIT, normalized, nowISO, STAGES, trim, uid, validDate } from './domain.js';
import { postingIdentity } from './sources.js';

const submissionProof = new Set(['ats-receipt','email-confirmation','user-confirmed','csv-confirmed']);
const terminal = new Set(['Rejected','Withdrawn','Accepted']);
const progressing = new Set(['Applied','OA','Interview','Offer']);
const initial = new Set(['Saved','Preparing']);

export async function findJob(keys = [], urls = []) {
  const direct = keys.length ? await db.jobs.where('keys').anyOf(keys).distinct().toArray() : [];
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) throw new Error('Conflicting posting identities. Review the records before linking.');
  if (!urls.length) return null;
  const exact = await db.jobs.where('urls').anyOf(urls).distinct().toArray();
  const identities = new Set(keys.map(key => key.slice(0,key.lastIndexOf(':'))));
  const compatible = exact.filter(job => !job.keys.some(key => identities.has(key.slice(0,key.lastIndexOf(':')))));
  if (compatible.length > 1) throw new Error('Multiple records use this URL. Select an existing application explicitly.');
  return compatible[0] ?? null;
}

export function describeImport(raw) {
  const url = raw.url ? canonicalUrl(raw.url) : '';
  if (raw.url && !url) throw new Error('Enter a valid web URL.');
  const identity = postingIdentity(url);
  const actionableUrl = url && (identity || new URL(url).pathname !== '/' || new URL(url).search);
  const job = {
    url, urls:actionableUrl ? [url] : [], keys:identity ? [identity.key] : [],
    company:trim(raw.company).slice(0,180), title:trim(raw.title).slice(0,240),
    requisition:trim(raw.requisition ?? raw.job_id).slice(0,120), location:trim(raw.location).slice(0,240),
    roleCategory:trim(raw.roleCategory), seniority:trim(raw.seniority), workMode:trim(raw.workMode),
    employmentType:trim(raw.employmentType), priority:trim(raw.priority), attribution:trim(raw.attribution ?? raw.source) || (url ? new URL(url).hostname : 'Manual'),
    provider:identity?.source.provider ?? 'manual', externalId:identity?.externalId ?? trim(raw.externalId)
  };
  if (!job.title || !job.company) throw new Error('Company and job title are required.');
  return job;
}

export function deriveApplication(application, records) {
  const reversed = new Set(records.filter(event => event.kind === 'undo').map(event => event.reverses));
  const events = records.filter(event => !reversed.has(event.id) && event.kind !== 'undo')
    .sort((a,b) => Date.parse(a.at) - Date.parse(b.at) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  let status = 'Saved', appliedAt = null, submission = 'unverified', review = false;
  let updatedAt = application.createdAt;
  let materials = application.materials ?? {};
  let correction;
  for (const e of events) {
    if (e.kind === 'materials') materials = e.materials;
    if (e.kind === 'submission-reset') { appliedAt = null; submission = 'unverified'; }
    if (e.kind === 'submission-date') {
      appliedAt = e.submissionDate ?? null;
      submission = appliedAt ? (submission==='confirmed'?'confirmed':'submitted') : 'unverified';
    }
    if (submissionProof.has(e.kind)) {
      appliedAt ??= e.at;
      submission = e.kind === 'ats-receipt' || e.kind === 'email-confirmation' ? 'confirmed' : submission === 'confirmed' ? 'confirmed' : 'submitted';
    }
    if (e.kind === 'needs-check' && !appliedAt) submission = 'needs_check';
    if (!e.stage || !STAGES.includes(e.stage)) continue;
    if (e.kind === 'correction' || (e.kind === 'user-confirmed' && e.forceStage)) {
      status = e.stage; correction = e.at; updatedAt = e.at; review = false;
      continue;
    }
    if (correction && Date.parse(e.at) <= Date.parse(correction)) continue;
    if (e.stage === 'Applied' && !initial.has(status)) continue;
    if (initial.has(e.stage) && !initial.has(status)) continue;
    if (terminal.has(status) && status !== e.stage) { if (terminal.has(e.stage) || progressing.has(e.stage)) review = true; continue; }
    if (e.stage === 'Applied' && !appliedAt) continue;
    if (e.stage === 'Applied' && status === 'Applied') continue;
    status = e.stage;
    updatedAt = e.at;
  }
  return {...application,status,updatedAt,appliedAt,submission,review,materials};
}

export async function appendEvent(event, generation = null) {
  return guarded(generation,[db.events,db.applications],async () => recordEvent(event));
}
export async function recordEvent(event) {
  if (await db.events.get(event.id) || (event.messageId && await db.events.where('messageId').equals(event.messageId).first())) return { duplicate:true };
  const entry = {...event,at:validDate(event.at)?new Date(event.at).toISOString():nowISO(),order:Date.now()};
  const app = entry.applicationId && await db.applications.get(entry.applicationId);
  if (entry.applicationId && !app) throw new Error('Application record no longer exists.');
  await db.events.add(entry);
  if (!app) return { event:entry };
  const result = deriveApplication(app,await db.events.where('applicationId').equals(app.id).toArray());
  await db.applications.put(result);
  return { event:entry, application:result };
}

export async function saveApplication(raw, { stage = 'Saved', jobId = '', existingId = '', pageDescription = '', tracking } = {}) {
  return db.transaction('rw',db.jobs,db.applications,db.events,async () => {
    const input = jobId ? null : describeImport(raw);
    const userDescription = typeof raw?.jobDescription==='string' ? raw.jobDescription.trim().slice(0,JOB_DESCRIPTION_LIMIT) : undefined;
    const capturedDescription = typeof pageDescription==='string' ? pageDescription.trim().slice(0,JOB_DESCRIPTION_LIMIT) : '';
    const existing = existingId ? await db.applications.get(existingId) : null;
    if (existingId && !existing) throw new Error('Selected application no longer exists.');
    let job = jobId ? await db.jobs.get(jobId) : existing ? await db.jobs.get(existing.jobId) : await findJob(input.keys,input.urls);
    if (!job && !input) throw new Error('Job no longer exists.');
    if (!job) {
      job = {...input,id:uid(),active:false,official:false,firstSeenAt:nowISO(),sourceIds:[],members:{},manual:true};
      await db.jobs.add(job);
    }
    const same = existing ?? await db.applications.where('jobId').equals(job.id).first();
    if (same) {
      const jobDescription = userDescription ?? same.jobDescription ?? (capturedDescription || undefined);
      if (existing) {
        const edited = {...same,notes:String(raw?.notes ?? same.notes).slice(0,24000),
          company:input?.company ?? same.company,title:input?.title ?? same.title,location:input?.location ?? same.location,
          url:input?.url ?? same.url,requisition:input?.requisition ?? same.requisition,
          ...(jobDescription!==undefined?{jobDescription}:{}),
          ...(raw?.source!==undefined||raw?.attribution!==undefined?{source:input.attribution}:{}),
          ...(raw?.seniority!==undefined?{seniority:input.seniority}:{}),
          ...(raw?.workMode!==undefined?{workMode:input.workMode}:{}),
          ...(raw?.priority!==undefined?{priority:input.priority}:{})};
        await db.applications.put(edited);
        if(tracking) {
          const {stage,submissionDate}=tracking;
          if(!STAGES.includes(stage)) throw new Error('Choose a valid application stage.');
          if(submissionDate===null&&stage==='Applied') throw new Error('Choose a different stage to clear the submission date.');
          if(submissionDate!=null&&!validDate(submissionDate)) throw new Error('Enter a valid submission date.');
          const date=submissionDate===undefined&&stage==='Applied'&&!same.appliedAt?nowISO():submissionDate;
          if(date!==undefined&&date!==same.appliedAt) {
            await recordEvent({id:uid(),applicationId:same.id,kind:'submission-date',submissionDate:date});
          }
          if(stage!==same.status) {
            await recordEvent({id:uid(),applicationId:same.id,kind:'correction',stage});
          }
        }
      } else if (capturedDescription && same.jobDescription===undefined) {
        await db.applications.update(same.id,{jobDescription:capturedDescription});
      }
      if (stage === 'Preparing' && same.status === 'Saved') await recordEvent({id:'prepare:'+same.id,applicationId:same.id,kind:'stage',stage});
      return {application:await db.applications.get(same.id),duplicate:true};
    }
    const at = nowISO();
    const similar = normalized(job.company) && (await db.applications.toArray()).some(app => normalized(app.company) === normalized(job.company) && normalized(app.title) === normalized(job.title));
    const application = {
      id:uid(),jobId:job.id,company:input?.company ?? job.company,title:input?.title ?? job.title,
      url:input?.url || job.url,requisition:input?.requisition || job.requisition || job.externalId,
      location:input?.location || job.location,source:input?.attribution || job.attribution || job.provider,
      roleCategory:input?.roleCategory || job.roleCategory,seniority:input?.seniority || job.seniority,
      workMode:input?.workMode || job.workMode,priority:input?.priority || job.priority,employmentType:input?.employmentType || job.employmentType,
      sponsorshipStatus:job.sponsorship?.status,postedAt:job.postedAt,firstSeenAt:job.firstSeenAt,
      jobDescription:userDescription ?? (capturedDescription || job.jd || undefined),
      createdAt:at,updatedAt:at,notes:String(raw?.notes ?? '').slice(0,24000),status:'Saved',submission:'unverified'
    };
    await db.applications.add(application);
    const result = await recordEvent({id:'create:'+application.id,kind:'stage',stage,at,applicationId:application.id});
    return {application:result.application,similar:!!similar};
  });
}

export async function deleteApplication(id) {
  return db.transaction('rw',db.applications,db.events,db.runtime,async()=>{
    if(!await db.applications.get(id)) return false;
    const events=()=>db.events.where('applicationId').equals(id);
    await events().and(event=>!!event.messageId).modify(event=>{
      delete event.applicationId;
      delete event.stage;
      event.kind='email';
      event.pendingRead=false;
      event.review=!!event.urgent;
    });
    await events().delete();
    await db.runtime.where('kind').equals('form').and(row=>row.appId===id).delete();
    await db.applications.delete(id);
    return true;
  });
}

export async function changeStage(id, stage, at, note) {
  if (!STAGES.includes(stage)) throw new Error('Choose a valid application stage.');
  if (stage === 'Applied') return appendEvent({id:uid(),applicationId:id,kind:'user-confirmed',stage,at,note:trim(note),forceStage:true});
  return appendEvent({id:uid(),applicationId:id,kind:'correction',stage,at,note:trim(note)});
}
export async function undoEvent(id) {
  return db.transaction('rw',db.events,db.applications,async () => {
    const entry = await db.events.get(id);
    if (!entry || entry.kind === 'undo') throw new Error('This event cannot be undone.');
    return recordEvent({ id:'undo:'+id,applicationId:entry.applicationId,kind:'undo',reverses:id });
  });
}
export async function actionState(id, operation) {
  return db.transaction('rw',db.events,async () => {
    const event = await db.events.get(id);
    if (!event?.urgent) throw new Error('Action item no longer exists.');
    const at = nowISO();
    const change = operation === 'resolve' ? {resolvedAt:at,acknowledgedAt:event.acknowledgedAt || at} :
      operation === 'reopen' ? {resolvedAt:null,acknowledgedAt:null} : {acknowledgedAt:at};
    await db.events.update(id,change);
  });
}

export function expiryEvidence(evidence, expected, current) {
  if (!evidence || !expected || !httpUrl(current)) return null;
  const originalIdentity = postingIdentity(expected.url);
  const receiptIdentity = postingIdentity(current);
  if (originalIdentity && receiptIdentity && originalIdentity.key !== receiptIdentity.key) return null;
  if (httpUrl(expected.url)?.origin !== httpUrl(current).origin) return null;
  if (evidence.provider !== expected.provider || !evidence.signature) return null;
  return {url:canonicalUrl(current),signature:String(evidence.signature).slice(0,160)};
}
