import { claim, db, guarded, release, settings, updateSettings } from './db.js';
import { discoveryRank, candidateDetails, monitorSource, retainRecords, sourceFailure } from './discovery.js';
import { canonicalUrl, freshness, localSlot, nowISO, preferenceDecision, publicUrl, uid } from './domain.js';
import { evaluateCandidate, getClaudePermission, newClaude } from './intelligence.js';
import { syncMail } from './mail.js';
import { collect, detectSource, fetchPublic, postingIdentity, respectWorkdayRobots } from './sources.js';
import { findJob } from './tracker.js';

const ALARM = 'meshjob-schedule';
const activeRuns = new Map();
const cancelled = new Set();
const icon = 'icons/icon128.png';
export const pattern = url => new URL(url).origin+'/*';

export async function checkMode(generation,signal) {
  signal?.throwIfAborted();
  if (generation == null) return;
  const config = await settings();
  if (config.mode !== 'Active' || config.generation !== generation) throw new Error('Automatic work stopped.');
}
function cancellationSignal(id,generation,scope) {
  const controller = new AbortController();
  const key = id || uid();
  activeRuns.set(key,{controller,generation,scope});
  if (cancelled.delete(key)) controller.abort();
  return {key,signal:controller.signal,done:()=>activeRuns.delete(key)};
}
export function cancelOperation(key) {
  const run = activeRuns.get(key);
  if (run) run.controller.abort();
  else {
    if (cancelled.size >= 30) cancelled.delete(cancelled.values().next().value);
    cancelled.add(key);
  }
}
function clearRuns(automaticOnly, scope) {
  for (const run of activeRuns.values()) if ((!automaticOnly || run.generation != null) && (!scope || run.scope === scope)) run.controller.abort();
}

export function scopedFetch(generation,signal,allowedOrigin) {
  return async (url,options={})=>{
    await checkMode(generation,signal);
    const target = publicUrl(url);
    if (!target || (allowedOrigin && target.origin !== allowedOrigin) || !await chrome.permissions.contains({origins:[pattern(target)]})) {
      throw new Error('Access was not granted for this source origin.');
    }
    await checkMode(generation,signal);
    return fetchPublic(target.href,{...options,signal:options.signal??signal});
  };
}

export async function claudeFor(config,generation,signal) {
  const {claudeKey} = await chrome.storage.local.get('claudeKey');
  if (!claudeKey || !await getClaudePermission()) return null;
  return newClaude({config,key:claudeKey,generation,signal,fetcher:async (url,options)=>{
    await checkMode(generation,signal);
    return fetch(url,options);
  }});
}
export async function setMode(mode) {
  if (!['Active','Paused','Finished'].includes(mode)) throw new Error('Choose a valid search mode.');
  const before = await settings();
  if (before.mode === mode) return before;
  if (mode !== 'Active') clearRuns(true);
  const next = await updateSettings(current=>({...current,mode,generation:current.generation+1,modeChangedAt:nowISO()}));
  if (mode !== 'Active') {
    clearRuns(true);
    await chrome.alarms.clear(ALARM);
    await Promise.all(Object.keys(await chrome.notifications.getAll()).filter(id=>id.startsWith('meshjob:')).map(id=>chrome.notifications.clear(id)));
    await chrome.action.setBadgeText({text:''});
    if(mode==='Finished') await db.runtime.where('kind').anyOf('retry','candidate').delete();
  } else {
    await arm();
    void tick().catch(reportSchedulerError);
  }
  return next;
}
export function stopSource(id) { clearRuns(false,'source:'+id); }
export function stopMail() { clearRuns(false,'gmail'); }

function notifiedId(event) { return 'meshjob:mail:'+event.id; }
export async function notifyUrgent(generation) {
  const config = await settings();
  if (config.mode !== 'Active' || (generation != null && generation !== config.generation)) return;
  const expected = config.generation;
  const [entries,undo]=await Promise.all([
    db.events.filter(event=>event.urgent && !event.resolvedAt).toArray(),db.events.filter(event=>event.kind==='undo').toArray()
  ]);
  const reversed=new Set(undo.map(event=>event.reverses));
  const pending = entries.filter(event=>!event.acknowledgedAt&&!reversed.has(event.id)).sort((a,b)=>b.at.localeCompare(a.at));
  const unseen = pending.filter(event=>!event.notifiedAt).slice(0,10);
  await checkMode(expected);
  await chrome.action.setBadgeBackgroundColor({color:'#a52b38'});
  await chrome.action.setBadgeText({text:pending.length ? String(Math.min(99,pending.length)) : ''});
  if ((await settings()).mode!=='Active') {await chrome.action.setBadgeText({text:''});return;}
  for (const event of unseen) {
    await checkMode(expected);
    const lease = await claim('notification:'+event.id,'notification',45_000,expected);
    if (!lease) continue;
    try {
      await checkMode(expected);
      const latest = await db.events.get(event.id);
      if (!latest || latest.notifiedAt || latest.acknowledgedAt || latest.resolvedAt) continue;
      await chrome.notifications.create(notifiedId(event),{type:'basic',iconUrl:icon,title:'MeshJob · Action required',message:event.subject || 'Recruiting message needs review.',priority:2});
      const saved = await guarded(expected,[db.events],async()=>db.events.update(event.id,{notifiedAt:nowISO()}));
      if (!saved) await chrome.notifications.clear(notifiedId(event));
    } finally { await release('notification:'+event.id,lease); }
  }
}
export async function testNotification() {
  return chrome.notifications.create('meshjob:test',{type:'basic',iconUrl:icon,title:'MeshJob test notification',message:'Urgent recruiting messages appear in your Action Required queue.'});
}

async function directAlert(job,source,config,generation,signal) {
  if (!config.directAlerts || !config.preferences.titles.length || !job.official || job.identityReview || job.notifiedAt || job.repost ||
    !['verified','detected'].includes(freshness(job,Math.min(24,config.preferences.freshnessHours))) ||
    !preferenceDecision(job,config.preferences).eligible || config.modeChangedAt && (job.postedAt||job.firstSeenAt) < config.modeChangedAt ||
    await db.applications.where('jobId').equals(job.id).first()) return;
  await checkMode(generation,signal);
  const id = 'meshjob:job:'+job.id;
  await chrome.notifications.create(id,{type:'basic',iconUrl:icon,title:job.title,message:job.company+(job.location?' · '+job.location:''),priority:0});
  const written = await guarded(generation,[db.jobs],()=>db.jobs.update(job.id,{notifiedAt:nowISO(),notificationSource:source.id}));
  if (!written) await chrome.notifications.clear(id);
}

async function queueCandidates(rows,source,config,generation) {
  const targets=rows.filter(({job,newJob,reopened,item})=>{
    const rank=discoveryRank(job,config);
    return job.official&&!job.identityReview &&
      (rank<=1&&(newJob||reopened||!job.jd||item.updatedAt!==job.jdUpdatedAt)||source.recheckCandidates&&rank<=2&&!job.jd) &&
      preferenceDecision(job,{...config.preferences,strictUnknown:false}).eligible;
  }).sort((a,b)=>discoveryRank(a.job,config)-discoveryRank(b.job,config));
  if (!targets.length&&!source.recheckCandidates) return;
  await guarded(generation,[db.runtime,db.sources],async()=>{
    const current=await db.sources.get(source.id);
    if(!current?.enabled) return;
    for(const {job,item,newJob} of targets.slice(0,250)) {
      const id='candidate:'+job.id;
      const prior=await db.runtime.get(id);
      const allowedToStore=!!item.jd && preferenceDecision({...job,sponsorship:undefined},{...config.preferences,strictUnknown:false}).eligible;
      await db.runtime.put({id,kind:'candidate',sourceId:source.id,jobId:job.id,
        item:{...item,jd:allowedToStore?item.jd:undefined},newJob:prior?.newJob||newJob,
        generation,createdAt:prior?.createdAt??Date.now(),expiresAt:Date.now()+86400000,attempts:prior?.attempts??0,nextAt:prior?.nextAt??0});
    }
    if(current.recheckCandidates===source.recheckCandidates) await db.sources.update(source.id,{recheckCandidates:null});
  });
}

async function candidateBatch(config,generation,onlySource) {
  const id='run:candidates';
  const lease=await claim(id,'lease',90_000,generation);
  if(!lease) return;
  const run=cancellationSignal(null,generation,'candidates');
  try {
    const tasks=(await db.runtime.where('kind').equals('candidate').filter(row=>
      row.expiresAt>=Date.now() && row.nextAt<=Date.now() && (!onlySource||row.sourceId===onlySource)).toArray())
      .sort((a,b)=>a.createdAt-b.createdAt).slice(0,12);
    const provider=config.autoMatch?await claudeFor(config,generation,run.signal):null;
    await Promise.all(Array.from({length:3},async()=>{
      while(tasks.length) {
        const pending=tasks.shift();
        await checkMode(generation,run.signal);
        const [source,job]=await Promise.all([db.sources.get(pending.sourceId),db.jobs.get(pending.jobId)]);
        const remove=()=>guarded(generation,[db.runtime],async()=>{
          const current=await db.runtime.get(pending.id);
          if(current?.createdAt===pending.createdAt) await db.runtime.delete(pending.id);
        });
        if(!source?.enabled||!job?.active||!job.official||job.identityReview||job.updatedAt!==pending.item.updatedAt&&pending.item.updatedAt) {
          await remove();continue;
        }
        let candidate=job;
        try {
          candidate=await candidateDetails({job,item:pending.item},source,{config,generation,signal:run.signal,
            fetcher:scopedFetch(generation,run.signal,source.origin)});
          if(generation!=null&&pending.newJob) await directAlert(candidate,source,config,generation,run.signal);
        } catch(error) {
          if(run.signal.aborted) throw error;
          await guarded(generation,[db.jobs,db.runtime],async()=>{
            await db.jobs.update(job.id,{detailError:String(error.message).slice(0,140)});
            const next=pending.attempts+1;
            if(next>=3) await db.runtime.delete(pending.id);
            else await db.runtime.update(pending.id,{attempts:next,nextAt:Date.now()+next*300000});
          });
          continue;
        }
        if(provider&&candidate.jd&&discoveryRank(candidate,config)<2) {
          try {await evaluateCandidate(candidate,config,provider,generation);}
          catch(error) {
            if(run.signal.aborted) throw error;
            await guarded(generation,[db.jobs],()=>db.jobs.update(job.id,{analysisError:String(error.message).slice(0,160)}));
          }
        }
        await remove();
      }
    }));
  } finally {run.done();await release(id,lease);}
}

export async function runSource(id,{generation,op,full=false}={}) {
  const lock = await claim('run:source:'+id,'lease',5*60_000,generation);
  if (!lock) return {busy:true};
  const run = cancellationSignal(op,generation,'source:'+id);
  try {
    const source = await db.sources.get(id);
    if (!source?.enabled) throw new Error('Enable this source first.');
    const fetcher = scopedFetch(generation,run.signal,source.origin);
    await checkMode(generation,run.signal);
    const attempted = await guarded(generation,[db.sources],()=>db.sources.update(id,{inProgressAt:nowISO(),nextAt:Date.now()+source.interval*60_000}));
    if (!attempted) return;
    try {
      await respectWorkdayRobots(source,fetcher,run.signal);
      const result=await monitorSource(source,{generation,signal:run.signal,fetcher,full,
        onCandidates:async rows=>queueCandidates(rows,source,await settings(),generation)});
      if(generation==null) await candidateBatch(await settings(),generation,source.id);
      return result;
    } catch(error) {
      if(error.robots) await sourceFailure(source,error,generation,source.inProgressAt??nowISO());
      throw error;
    } finally {
      await guarded(generation,[db.sources],()=>db.sources.update(id,{inProgressAt:null}));
    }
  } finally { run.done(); await release('run:source:'+id,lock); }
}

export async function previewSource(raw, op) {
  const config = detectSource(raw.url,raw.provider);
  config.permitted = !!raw.permitted;
  const run = cancellationSignal(op,null);
  try {
    const fetcher=scopedFetch(null,run.signal,config.origin);
    await respectWorkdayRobots(config,fetcher,run.signal);
    const response = await collect(config,{fetcher,signal:run.signal});
    return {source:config,count:response.items.length,examples:response.items.slice(0,3).map(({company,title,location})=>({company,title,location}))};
  } finally { run.done(); }
}

export async function addSources(entries) {
  const batch = [];
  for (const raw of entries.slice(0,160)) {
    const source = detectSource(raw.url,raw.provider);
    const hasPermission = await chrome.permissions.contains({origins:[pattern(source.endpoint)]});
    if (source.provider === 'workday' && !raw.permitted) throw new Error('Workday requires permission confirmation for the specific site.');
    source.name = String(raw.name || source.name).trim().slice(0,150);
    source.interval = Math.max(10,Math.min(1440,Math.round(Number(raw.interval)||10)));
    source.enabled = hasPermission && raw.enabled !== false;
    source.permitted = !!raw.permitted;
    source.nextAt = Date.now()+Math.floor(Math.random()*7*60_000);
    batch.push(source);
  }
  return db.transaction('rw',db.sources,async()=>{
    let added=0;
    for (const item of batch) if (!await db.sources.get(item.id)) {await db.sources.add(item);added++;}
    return added;
  });
}

export async function searchNow({generation,op}={}) {
  const lock = await claim('run:search','lease',75_000,generation);
  if (!lock) return {busy:true};
  const task = cancellationSignal(op,generation,'search');
  try {
    const config = await settings();
    if (!config.preferences.titles.length) throw new Error('Add target job titles in Discover → Preferences before searching.');
    const claude = await claudeFor(config,generation,task.signal);
    if (!claude) throw new Error('Connect Claude in Profile before running a web search.');
    const preferences = Object.fromEntries(['titles','aliases','locations','countries','seniority','employmentType','workMode'].map(key=>[key,config.preferences[key].slice(0,12)]));
    const leads = await claude.searchJobs({...preferences,freshnessHours:config.preferences.freshnessHours});
    // Leads are verified through the employer's own ATS API; unverifiable leads are dropped and new boards are suggested (spec 3.3).
    let count=0, boards=0;
    const snapshots=new Map();
    for (const lead of leads) {
      await checkMode(generation,task.signal);
      const identity = postingIdentity(lead.url);
      if (!identity) continue;
      const {source}=identity;
      if (!await db.sources.get(source.id) && !await db.runtime.get('suggest:'+source.id)) {
        const saved=await guarded(generation,[db.runtime],()=>db.runtime.put({id:'suggest:'+source.id,kind:'suggestion',
          source:{...source,name:lead.company||source.name},title:lead.title,expiresAt:Date.now()+14*86_400_000}));
        if (saved!==null) boards++;
      }
      if (source.provider==='workday' || !await chrome.permissions.contains({origins:[pattern(source.endpoint)]})) continue;
      try {
        if (!snapshots.has(source.id)) snapshots.set(source.id,await collect(source,{fetcher:scopedFetch(generation,task.signal,source.origin)}));
      } catch (error) { if (task.signal.aborted) throw error; snapshots.set(source.id,{items:[]}); }
      const item = snapshots.get(source.id).items?.find(row=>row.keys.includes(identity.key));
      if (!item) continue;
      const {jd, ...listing} = item;
      const added = await guarded(generation,[db.jobs],async()=>{
        if (await findJob(listing.keys,[listing.url])) return false;
        const job = {...listing,id:uid(),urls:[listing.url],firstSeenAt:nowISO(),sourceIds:[],members:{},active:true,official:true,lead:true,verifiedAt:nowISO()};
        if (!preferenceDecision(job,config.preferences).eligible) return false;
        await db.jobs.add(job);
        return true;
      });
      if (added) count++;
    }
    return {count,boards};
  } finally { task.done(); await release('run:search',lock); }
}

export async function runMail({generation,op}={}) {
  const run = cancellationSignal(op,generation,'gmail');
  const config = await settings();
  try {
    const ai = await claudeFor(config,generation,run.signal);
    return await syncMail({config,generation,signal:run.signal,notify:notifyUrgent,ai});
  } finally { run.done(); }
}

async function serviceAttempt(id,fn,generation,interval) {
  const at = nowISO();
  const previous=await db.runtime.get(id);
  await guarded(generation,[db.runtime],()=>db.runtime.put({id,kind:'health',attemptAt:at,successAt:previous?.successAt,nextAt:Date.now()+interval,running:true}));
  try {
    const result = await fn();
    await guarded(generation,[db.runtime],()=>db.runtime.put({id,kind:'health',attemptAt:at,successAt:nowISO(),nextAt:Date.now()+(result?.hasMore ? 60_000 : interval),result}));
    return {result};
  } catch(error) {
    await guarded(generation,[db.runtime],()=>db.runtime.put({id,kind:'health',attemptAt:at,successAt:previous?.successAt,error:String(error.message??error).slice(0,350),nextAt:Date.now()+interval}));
    if (generation == null) throw error;
  }
}
export async function recordManualRun(kind,op) {
  return serviceAttempt(kind==='gmail'?'health:gmail':'health:search',()=>kind==='gmail'?runMail({op}):searchNow({op}),null,300_000);
}
async function reportSchedulerError(error) {
  const state = await settings();
  await guarded(state.generation,[db.runtime],()=>db.runtime.put({id:'health:scheduler',kind:'health',at:nowISO(),error:String(error.message ?? error).slice(0,250)}));
}
export async function arm() {
  const config = await settings();
  if (config.mode !== 'Active') return chrome.alarms.clear(ALARM);
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM,{periodInMinutes:.5});
  if ((await settings()).mode!=='Active') await chrome.alarms.clear(ALARM);
}

async function claimSlot(key,generation) {
  return guarded(generation,[db.runtime],async()=>{
    if (await db.runtime.get(key)) return false;
    await db.runtime.add({id:key,kind:'slot',at:nowISO(),expiresAt:Date.now()+2*86400000});
    return true;
  });
}

async function observeMissedSlots(config,generation,now) {
  if (!config.slots.length || !(await chrome.storage.local.get('claudeKey')).claudeKey) return;
  const current=new Date(now);
  const {day}=localSlot(current,[]);
  await guarded(generation,[db.runtime],async()=>{
    const previous=await db.runtime.get('clock:search');
    if(previous) {
      const missed=[];
      for(const slot of config.slots) {
        const [hours,minutes]=slot.split(':').map(Number);
        const time=new Date(current.getFullYear(),current.getMonth(),current.getDate(),hours,minutes).getTime();
        const key='slot:'+day+':'+slot;
        const floor=Math.max(previous.seenAt,Date.parse(config.modeChangedAt??'')||0);
        if(time<floor||time+120_000>now||await db.runtime.get(key)) continue;
        await db.runtime.add({id:key,kind:'slot',state:'missed',at:new Date(time).toISOString(),expiresAt:now+2*86400000});
        missed.push(slot);
      }
      if(missed.length) await db.runtime.put({id:'health:missed-search',kind:'health',at:nowISO(),slots:missed,day});
    }
    await db.runtime.put({id:'clock:search',kind:'clock',seenAt:now});
  });
}

export async function tick() {
  const config = await settings();
  if (config.mode !== 'Active' || !config.onboarded) return;
  const generation = config.generation;
  const lock = await claim('run:scheduler','lease',45_000,generation);
  if (!lock) return;
  try {
    const now = Date.now();
    await observeMissedSlots(config,generation,now);
    const ready = (await db.sources.filter(source=>source.enabled && (!source.nextAt || source.nextAt<=now)).toArray())
      .sort((a,b)=>(a.nextAt??0)-(b.nextAt??0)).slice(0,5);
    const mailHealth = await db.runtime.get('health:gmail');
    const today = localSlot(new Date(),config.slots);
    const mail = config.gmail && (!mailHealth?.nextAt || mailHealth.nextAt<=now) ?
      serviceAttempt('health:gmail',()=>runMail({generation}),generation,300_000) : null;
    const search = config.dailySearch && config.preferences.titles.length && today.key && await claimSlot(today.key,generation) ?
      serviceAttempt('health:search',async()=>{
        if (!await claudeFor(config,generation)) return {skipped:'Claude is disabled'};
        return searchNow({generation});
      },generation,300_000) : null;
    const sourceRuns = Promise.all(Array.from({length:3},async()=>{
      while (ready.length) {
        const source = ready.shift();
        try { await runSource(source.id,{generation}); } catch { /* Source health is durable. */ }
      }
    }));
    await Promise.allSettled([mail,search,sourceRuns,candidateBatch(config,generation),notifyUrgent(generation)]);
    if (await claimSlot('maintenance:'+today.day,generation)) await retainRecords(config,generation);
  } finally { await release('run:scheduler',lock); }
}

export function registerSchedules() {
  const start = ()=>{ void arm().then(tick).catch(reportSchedulerError); };
  chrome.alarms.onAlarm.addListener(alarm=>{if (alarm.name===ALARM) void tick().catch(reportSchedulerError);});
  chrome.runtime.onInstalled.addListener(start);
  chrome.runtime.onStartup.addListener(start);
  void arm().catch(reportSchedulerError);
}
