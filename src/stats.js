export function percentile(values,p) {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
}
export function statsPeriod(period,at=new Date()) {
  const year=at.getFullYear(),month=at.getMonth();
  const start={
    week:new Date(year,month,at.getDate()-(at.getDay()+6)%7),
    month:new Date(year,month,1),
    year:new Date(year,0,1)
  }[period];
  if(!start) return {label:'All time'};
  const date=new Intl.DateTimeFormat(undefined,{dateStyle:'medium'});
  return {start:start.getTime(),end:at.getTime(),label:date.format(start)+' – '+date.format(at)};
}
export function analyze({applications,events,range={}}) {
  const reversed=new Set(events.filter(event=>event.kind==='undo').map(event=>event.reverses));
  const reached=new Map();
  for(const event of events) {
    if(!event.applicationId||!event.stage||reversed.has(event.id))continue;
    if(!reached.has(event.applicationId))reached.set(event.applicationId,new Set());
    reached.get(event.applicationId).add(event.stage);
  }
  const submitted=applications.filter(app=>{
    if(!app.appliedAt)return false;
    const at=Date.parse(app.appliedAt);
    return Number.isFinite(at)&&(range.start==null||at>=range.start)&&(range.end==null||at<=range.end);
  });
  const stageCount=stage=>submitted.filter(app=>app.status===stage||reached.get(app.id)?.has(stage)).length;
  return {overall:{applications:submitted.length,OA:stageCount('OA'),interviews:stageCount('Interview'),
    offers:stageCount('Offer'),rejected:stageCount('Rejected'),withdrawn:stageCount('Withdrawn'),accepted:stageCount('Accepted')},
    drafts:applications.filter(app=>!app.appliedAt).length};
}
