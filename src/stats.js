const day = time=>String(time??'').slice(0,10);
const week = time=>{
  const date=new Date(time);
  date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  return day(date.toISOString());
};
export function percentile(values,p) {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
}
export const summarize=values=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95)});
const grouping=(values,select)=>{
  const result=new Map();
  for (const row of values) {
    const key=select(row)||'Unknown';
    if(!result.has(key)) result.set(key,[]);
    result.get(key).push(row);
  }
  return result;
};
const elapsed=(start,end)=>{
  if(!start||!end) return null;
  const ms=Date.parse(end)-Date.parse(start);
  return Number.isFinite(ms)&&ms>=0 ? ms : null;
};
export function analyze({applications,events,jobs,sources,usage}) {
  const reversed = new Set(events.filter(event=>event.kind==='undo').map(event=>event.reverses));
  const verifiedEvents=events.filter(event=>event.applicationId&&!reversed.has(event.id)&&event.kind!=='undo');
  const submitted=applications.filter(app=>app.appliedAt);
  const reached=grouping(verifiedEvents,e=>e.applicationId);
  const cohort=rows=>{
    const stageCount=stage=>rows.filter(app=>app.status===stage||reached.get(app.id)?.some(event=>event.stage===stage)).length;
    return {applications:rows.length,OA:stageCount('OA'),interviews:stageCount('Interview'),offers:stageCount('Offer'),
      rejected:stageCount('Rejected'),withdrawn:stageCount('Withdrawn'),accepted:stageCount('Accepted')};
  };
  const group=(rows,key)=>[...grouping(rows,key)].map(([label,rows])=>({label,...cohort(rows)})).sort((a,b)=>b.applications-a.applications);
  const overall=cohort(submitted);
  const counted=rows=>rows.filter(x=>x!=null);
  return {
    overall,drafts:applications.length-submitted.length,
    days:group(submitted,app=>day(app.appliedAt)).sort((a,b)=>b.label.localeCompare(a.label)),
    weeks:group(submitted,app=>week(app.appliedAt)).sort((a,b)=>b.label.localeCompare(a.label)),
    roles:group(submitted,app=>app.roleCategory||app.title),resumes:group(submitted,app=>app.materials?.resume?.name),
    coverLetters:group(submitted,app=>app.materials?.cover?.name),applicationSources:group(submitted,app=>app.source),
    sources:sources.map(source=>{
      const found=jobs.filter(job=>job.sourceIds?.includes(source.id));
      return {name:source.name,unique:found.length,active:found.filter(job=>job.members?.[source.id]?.active).length,
        latency:summarize(counted(found.map(job=>elapsed(job.postedAt,job.members?.[source.id]?.firstSeenAt))))};
    }).sort((a,b)=>b.unique-a.unique),
    postingToDiscovery:summarize(counted(jobs.map(job=>elapsed(job.postedAt,job.firstSeenAt)))),
    observationWindow:summarize(counted(jobs.map(job=>elapsed(job.lastAbsentAt,job.firstSeenAt)))),
    discoveryToApplication:summarize(counted(submitted.map(app=>elapsed(app.firstSeenAt,app.appliedAt)))),
    activeAutofill:summarize(verifiedEvents.filter(event=>event.kind==='autofill'&&Number.isFinite(event.duration)).map(event=>event.duration)),
    usage:[...grouping(usage,row=>row.month)].map(([month,rows])=>({
      month,requests:rows.filter(row=>!['cancelled','rejected'].includes(row.state)).length,
      searches:rows.reduce((n,row)=>n+(row.usage?.server_tool_use?.web_search_requests??0),0),
      pending:rows.filter(row=>row.state==='reserved').reduce((n,row)=>n+row.cost,0),
      cost:rows.filter(row=>row.state==='estimated').reduce((n,row)=>n+row.cost,0)
    })).sort((a,b)=>b.month.localeCompare(a.month))
  };
}
