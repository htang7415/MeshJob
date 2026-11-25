import { performance } from 'node:perf_hooks';
import { CATALOG } from '../src/catalog.js';
import { collect, fetchPublic } from '../src/sources.js';
import { referenceUrl } from './reference-boards.mjs';
import { percentile } from '../src/stats.js';

const concurrency=4;
const boards=CATALOG.filter(source=>!source.optional);
const results=[];
const startedAt=new Date().toISOString();
const candidate=process.argv.includes('--optional')?[...CATALOG]:boards;

const idsOf=(provider,data)=>{
  const rows=Array.isArray(data)?data:data.jobs;
  if(!Array.isArray(rows)) throw new Error('Unexpected reference data');
  return rows.filter(row=>provider==='ashby'?row.isListed!==false:provider==='greenhouse'?row.internal_job_id!==null:true).map(row=>
    String(provider==='ashby'?new URL(row.jobUrl).pathname.split('/').at(-1):row.id));
};
function diff(left,right) {
  const compared=new Set(right);
  return left.filter(item=>!compared.has(item));
}
await Promise.all(Array.from({length:concurrency},async()=>{
  while(candidate.length) {
    const source=candidate.shift();
    const record={id:source.id,provider:source.provider,url:source.url,observedAt:new Date().toISOString()};
    const start=performance.now();
    try {
      const real=await collect(source,{fetcher:fetchPublic});
      record.adapterMs=Math.round(performance.now()-start);
      record.adapterCount=real.items.length;
      record.verifiedTimeCount=real.items.filter(job=>job.postedAt&&job.official).length;
      const ref=referenceUrl(source.provider,source.tenant);
      if(!ref){results.push(record);continue;}
      record.referenceUrl=ref;
      const response=await fetch(ref,{signal:AbortSignal.timeout(15_000),redirect:'error',credentials:'omit'});
      record.referenceStatus=response.status;
      if(!response.ok)throw new Error('Reference HTTP '+response.status);
      const values=idsOf(source.provider,await response.json());
      const actual=real.items.map(row=>row.externalId);
      record.referenceCount=values.length;
      record.referenceMissing=diff(values,actual);
      record.adapterExtra=diff(actual,values);
      record.shared=values.length-record.referenceMissing.length;
      record.uniqueAdapterIds=new Set(actual).size;
    }catch(error){record.error=String(error.message??error);record.status=error.status??null;}
    results.push(record);
  }
}));
const good=results.filter(row=>!row.error);
const equivalent=good.filter(row=>row.shared!=null);
console.log(JSON.stringify({
  startedAt,completedAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,concurrency,
  boardsAttempted:results.length,boardsSucceeded:good.length,
  comparableBoards:equivalent.length,referenceJobs:equivalent.reduce((n,x)=>n+x.referenceCount,0),
  adapterJobs:good.reduce((n,x)=>n+x.adapterCount,0),sharedIds:equivalent.reduce((n,x)=>n+x.shared,0),
  verifiedPostingTimes:good.reduce((n,x)=>n+x.verifiedTimeCount,0),
  snapshotRequestMs:{median:percentile(good.map(x=>x.adapterMs),.5),p95:percentile(good.map(x=>x.adapterMs),.95)},
  records:results.sort((a,b)=>a.id.localeCompare(b.id))
},null,2));
