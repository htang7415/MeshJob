import { db, guarded, settings } from './db.js';
import { backoffMs, earliest, freshness, hash, levelOf, minYears, normalized, nowISO, preferenceDecision, sponsorshipEvidence, uid } from './domain.js';
import { collect, fetchPublic, jobDetails, verifyOfficialPosting } from './sources.js';
import { findJob } from './tracker.js';

const intervalMs = source => Math.max(10,source.interval || 10) * 60_000;

export async function saveSnapshot(source, snapshot, generation, startedAt = nowISO()) {
  const checkAt = nowISO();
  return guarded(generation,[db.sources,db.jobs],async () => {
    const current = await db.sources.get(source.id);
    if (!current?.enabled || current.endpoint !== source.endpoint || (current.lastAttemptAt && current.lastAttemptAt > startedAt)) return null;
    const success = {lastCompleteAt:checkAt,lastAttemptAt:startedAt,failures:0,error:null,nextAt:Date.now()+intervalMs(current),fetched:!snapshot.unchanged};
    if (snapshot.unchanged) {
      if (!current.lastCompleteAt) throw new Error('Received an unchanged response before an initial snapshot.');
      await db.sources.update(source.id,success);
      return [];
    }
    const previous = await db.jobs.where('sourceIds').equals(source.id).toArray();
    const seen = new Set();
    const changed = [];
    const repostWindow = Date.now()-30*86_400_000;
    const sameListing = (a,b) => normalized(a.title)===normalized(b.title) && normalized(a.location)===normalized(b.location);
    const uninterrupted = current.lastCompleteAt && !current.failures &&
      Date.parse(startedAt)-Date.parse(current.lastCompleteAt) <= intervalMs(current)*1.55;
    for (const {jd, ...item} of snapshot.items) {
      const existing = await findJob(item.keys,[item.url]);
      const oldMember = existing?.members?.[source.id];
      const firstOnBoard = !oldMember;
      const sameRole = !existing?.title || !item.title || normalized(existing.title) === normalized(item.title);
      const reopened = !!oldMember && !oldMember.active;
      const lastAbsentAt = existing ? existing.lastAbsentAt : firstOnBoard && uninterrupted ? current.lastCompleteAt : null;
      const members = {...existing?.members,[source.id]:{active:true,key:item.key,official:item.official,firstSeenAt:oldMember?.firstSeenAt??checkAt,lastSeenAt:checkAt}};
      const active = Object.values(members).some(member => member.active);
      const prefer = item.official || !existing?.official;
      const fields = Object.fromEntries(Object.entries(item).filter(([,value]) => value != null && value !== ''));
      const job = {
        ...existing,...(prefer ? fields : {}),id:existing?.id ?? uid(),
        firstSeenAt:existing?.firstSeenAt ?? checkAt,lastAbsentAt,active,members,
        sourceIds:Object.keys(members),keys:[...new Set([...(existing?.keys ?? []),...item.keys])],
        urls:[...new Set([...(existing?.urls ?? []),item.url])],
        official:Object.values(members).some(member => member.active && member.official),
        postedAt:existing?.postedAt ?? item.postedAt ?? null,
        ageFloor:earliest(existing?.ageFloor, item.ageFloor, existing?.postedAt),
        repost:existing ? existing.repost : !!current.lastCompleteAt && previous.some(other => other.members?.[source.id]?.key !== item.key && sameListing(other,item) &&
          (other.members?.[source.id]?.active || Date.parse(other.closedAt ?? '') > repostWindow)),
        dateEvidence:existing?.dateEvidence ?? item.dateEvidence,
        ...(reopened ? {reopenedAt:checkAt,closedAt:null} : {}),
        ...(existing && !sameRole && (reopened || !existing.active) ? {identityReview:true,match:null} : {})
      };
      if (!job.url) Object.assign(job, fields);
      if (!job.official && existing?.official) job.postedAt = existing.postedAt;
      if (job.identityReview) job.postedAt = null;
      seen.add(job.id);
      await db.jobs.put(job);
      changed.push({job,item:{...item,jd},reopened,newJob:!existing});
    }
    for (const job of previous) {
      if (seen.has(job.id) || !job.members?.[source.id]?.active) continue;
      const members = {...job.members,[source.id]:{...job.members[source.id],active:false}};
      const remaining = Object.values(members);
      const active = remaining.some(member => member.active);
      await db.jobs.update(job.id,{members,active,official:remaining.some(member => member.active && member.official),closedAt:active ? null : checkAt});
    }
    await db.sources.update(source.id,{...success,etag:snapshot.etag,modified:snapshot.modified,count:snapshot.items.length});
    return changed;
  });
}

export async function sourceFailure(source, error, generation, start) {
  await guarded(generation,[db.sources],async () => {
    const current = await db.sources.get(source.id);
    if (!current?.enabled || current.endpoint !== source.endpoint) return;
    const failures = (current.failures ?? 0)+1;
    await db.sources.update(source.id,{lastAttemptAt:start,failures,error:String(error.message ?? error).slice(0,360),
      nextAt:Date.now()+backoffMs(failures,intervalMs(current),error.retryAfter)});
  });
}

export async function monitorSource(source,{generation, signal, fetcher = fetchPublic, full = false, onCandidates} = {}) {
  const startedAt = nowISO();
  const config = await settings();
  if (generation != null && (config.mode !== 'Active' || config.generation !== generation)) return;
  let changed;
  try {
    const snapshot = await collect(source,{signal,fetcher,full});
    if (source.provider==='careers' && snapshot.items) {
      const verify=snapshot.items.filter(item=>item.postedAt && item.url!==source.endpoint);
      for(const item of verify.slice(0,8)) Object.assign(item,await verifyOfficialPosting(item,source,fetcher,signal));
      for(const item of verify.slice(8)) item.postedAt=null;
    }
    changed = await saveSnapshot(source,snapshot,generation,startedAt);
  } catch (error) {
    await sourceFailure(source,error,generation,startedAt);
    throw error;
  }
  if (onCandidates && changed?.length) await onCandidates(changed,source);
  return changed?.length ?? 0;
}

export async function candidateDetails({job,item},source,{config,generation,signal,fetcher = fetchPublic}) {
  if (!job.official || job.identityReview || !preferenceDecision(job,{...config.preferences,strictUnknown:false}).eligible) return job;
  let result = item;
  if (!item.jd) {
    if (job.jd && (!item.updatedAt || job.jdUpdatedAt === item.updatedAt) && ['greenhouse','workday'].includes(source.provider)) return job;
    result = await jobDetails(item,source,fetcher,signal);
  }
  if (!result.jd) return job;
  const jdHash = await hash(normalized(result.jd));
  const years = minYears(result.jd);
  const sponsorship = sponsorshipEvidence(result.jd,job.url,job.userVisaEvidence);
  const candidate = {...job,sponsorship,minYears:minYears(result.jd)};
  const allowed = preferenceDecision(candidate,config.preferences).eligible;
  const updates = {
    sponsorship,requisition:result.requisition ?? job.requisition,jdHash,minYears:years,seniority:job.seniority || levelOf(job.title,result.jd),
    jd:allowed ? result.jd : null,jdAt:allowed ? nowISO() : null,jdUpdatedAt:result.updatedAt,
    ...(job.jdHash && job.jdHash !== jdHash ? {match:null,matchKey:null} : {})
  };
  const committed = await guarded(generation,[db.jobs],async () => {
    const latest = await db.jobs.get(job.id);
    if (!latest?.active || latest.updatedAt !== job.updatedAt) return null;
    await db.jobs.update(job.id,updates);
    return {...latest,...updates};
  });
  return committed ?? job;
}

export function discoveryRank(job,config,date = Date.now()) {
  const age = freshness(job,config.preferences.freshnessHours,date);
  return age === 'verified' ? 0 : age === 'detected' ? 1 : age === 'unknown' ? 2 : 3;
}

export async function retainRecords(config,generation) {
  const protectedIds = new Set((await db.applications.toArray()).map(app => app.jobId));
  const now = Date.now();
  await guarded(generation,[db.jobs,db.runtime,db.usage],async () => {
    await db.jobs.toCollection().modify(job => {
      if (protectedIds.has(job.id)) return;
      if (job.jd && Date.parse(job.jdAt) < now-config.jdDays*86400000) delete job.jd;
      if (!job.active && job.closedAt && Date.parse(job.closedAt) < now-config.tombstoneDays*86400000) {
        delete job.jd; delete job.match; delete job.matchKey; delete job.sponsorship;
        job.members = Object.fromEntries(Object.entries(job.members ?? {}).map(([id,value]) => [id,{active:false,key:value.key}]));
      }
    });
    await db.runtime.where('kind').equals('candidate').filter(task=>task.expiresAt<now).delete();
    await db.runtime.where('expiresAt').below(now-8*86400000).delete();
  });
}
