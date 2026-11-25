import 'fake-indexeddb/auto';
import { test,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, settings, updateSettings } from '../src/db.js';
import { nowISO } from '../src/domain.js';
import { saveSnapshot, sourceFailure } from '../src/discovery.js';
import { appendEvent, changeStage, saveApplication, undoEvent } from '../src/tracker.js';
import { applicationCSV, csvPreview, importApplicationCSV, makeBackup, previewBackup, restoreBackup } from '../src/portability.js';
import { classifyMail, linkMail, mailEvent, syncMail } from '../src/mail.js';
import { newClaude } from '../src/intelligence.js';
import { detectSource } from '../src/sources.js';
import { analyze } from '../src/stats.js';
import { storeMaterial } from '../src/materials.js';

beforeEach(async()=>{await db.open();await Promise.all(db.tables.map(table=>table.clear()));});
const fixtureJob={company:'Acme Health',title:'Clinical Coordinator',url:'https://jobs.example.com/careers/1234',requisition:'REQ-1234'};
const fixtureMail={
  id:'m1',threadId:'thread1',at:'2026-11-20T12:00:00Z',subject:'Acme Health Clinical Coordinator · Application received',
  snippet:'Thanks for applying to the Clinical Coordinator position at Acme Health. REQ-1234',from:'jobs@acmehealth.example.com',unread:true
};
const source={...detectSource('https://job-boards.greenhouse.io/example'),name:'Example'};
function row(id,title='Data analyst') {const key=source.id+':'+id;return {key,keys:[key],externalId:String(id),url:source.url+'/jobs/'+id,company:source.name,title,official:true};}

test('baseline, complete diff, failures, reopening and lifecycle commit gate',async()=>{
  await db.sources.add(source);
  const older=new Date(Date.now()-4*60_000).toISOString();
  await saveSnapshot(source,{items:[row(1)]},0,older);
  assert.equal((await db.jobs.toArray())[0].lastAbsentAt,null);
  await saveSnapshot(source,{items:[row(1),row(2)]},0);
  const newJob=(await db.jobs.toArray()).find(job=>job.externalId==='2');
  assert.ok(newJob.lastAbsentAt);
  await sourceFailure(source,new Error('HTTP 500'),0,nowISO());
  assert.equal((await db.jobs.get(newJob.id)).active,true);
  const afterError=(await db.sources.get(source.id));
  assert.ok(afterError.lastCompleteAt);assert.equal(afterError.error,'HTTP 500');
  await saveSnapshot(source,{items:[row(1),row(3)]},0);
  assert.equal((await db.jobs.get(newJob.id)).active,false);
  assert.equal((await db.jobs.filter(job=>job.externalId==='3').first()).lastAbsentAt,null);
  await saveSnapshot(source,{items:[row(1),row(2,'Chief Scientist'),row(3)]},0);
  assert.equal((await db.jobs.get(newJob.id)).identityReview,true);
  assert.ok((await db.jobs.get(newJob.id)).reopenedAt);
  await updateSettings({mode:'Finished',generation:1});
  assert.equal(await saveSnapshot(source,{items:[]},0),null);
  assert.equal((await db.jobs.get(newJob.id)).active,true);
});
test('requisitions deduplicate without merging same-company different roles',async()=>{
  const first=await saveApplication(fixtureJob,{stage:'Preparing'});
  const same=await saveApplication({...fixtureJob,url:fixtureJob.url+'?utm_source=x'});
  const different=await saveApplication({...fixtureJob,url:fixtureJob.url+'5',requisition:'REQ-12345'});
  assert.equal(first.application.id,same.application.id);
  assert.equal(same.duplicate,true);
  assert.equal(different.similar,true);
  assert.notEqual(first.application.id,different.application.id);
  assert.equal(await db.applications.count(),2);
});
test('confirmation does not regress later stages, conflicting terminal events go to review and sync is undoable',async()=>{
  const {application:{id}}=await saveApplication(fixtureJob,{stage:'Preparing'});
  await appendEvent({id:'intent',kind:'needs-check',applicationId:id,at:'2026-11-15T00:00:01Z'});
  assert.equal((await db.applications.get(id)).submission,'needs_check');
  await appendEvent({id:'interview',kind:'email',stage:'Interview',applicationId:id,at:'2026-11-20T00:00:00Z',messageId:'b'});
  await appendEvent({id:'applied',kind:'email-confirmation',stage:'Applied',applicationId:id,at:'2026-11-18T00:00:00Z',messageId:'a'});
  assert.equal((await db.applications.get(id)).status,'Interview');
  assert.equal((await db.applications.get(id)).submission,'confirmed');
  await appendEvent({id:'reject',kind:'email',stage:'Rejected',applicationId:id,at:'2026-11-21T00:00:00Z'});
  await appendEvent({id:'accept',kind:'email',stage:'Accepted',applicationId:id,at:'2026-11-22T00:00:00Z'});
  assert.equal((await db.applications.get(id)).review,true);
  await undoEvent('reject');
  assert.equal((await db.applications.get(id)).status,'Accepted');
  assert.equal((await appendEvent({id:'repeat',kind:'email',applicationId:id,messageId:'a'})).duplicate,true);
});
test('CSV round-trips Unicode, formulas, quotes, multiline notes and skips duplicates',async()=>{
  const {application}=await saveApplication({company:'Clinique·联合',title:'Data Scientist',notes:'=formula("⚕")\n\'quoted\' "',url:fixtureJob.url});
  await changeStage(application.id,'Applied','2026-11-20T01:00:00Z');
  const csv=applicationCSV(await db.applications.toArray());
  assert.match(csv,/"'=formula\(""⚕""\)/);
  const source=csvPreview(csv,{unescape:true});
  assert.equal(source.entries[0].notes,application.notes);
  assert.equal((await importApplicationCSV(source)).duplicates,1);
  await Promise.all([db.jobs.clear(),db.events.clear(),db.applications.clear()]);
  const result=await importApplicationCSV(source);
  assert.deepEqual(result,{added:1,duplicates:0,errors:[]});
  const [restored]=await db.applications.toArray();
  assert.equal(restored.id,application.id);
  assert.equal(restored.company,application.company);
  assert.equal(restored.appliedAt,'2026-11-20T01:00:00.000Z');
});
test('backup round-trip preserves linked history, material PDF, and strips credentials and Gmail config',async()=>{
  const {application}=await saveApplication(fixtureJob);
  await changeStage(application.id,'Applied');
  await db.settings.put({id:'settings',profile:{givenName:'Example',unknown:'secret'},gmail:true,markRead:true,claudeKey:'not-a-real-key',password:'sentinel'});
  const material=await storeMaterial({file:new File(['%PDF-1.4\n%%EOF'],'resume.pdf',{type:'application/pdf'}),text:'An example',type:'resume'});
  const backup=await makeBackup();
  const pack=await previewBackup(backup);
  assert.equal(pack.records.settings.profile.givenName,'Example');
  assert.equal(pack.records.settings.profile.unknown,undefined);
  assert.equal('claudeKey' in pack.records.settings,false);
  assert.equal('gmail' in pack.records.settings,false);
  assert.equal(pack.records.materials[0].hash,material.item.hash);
  assert.equal(await pack.records.materials[0].blob.text(),'%PDF-1.4\n%%EOF');
  assert.equal((await restoreBackup(pack,'replace')).applications,1);
  assert.equal((await settings()).mode,'Paused');
  assert.equal((await db.events.where('applicationId').equals(application.id).toArray()).length,2);
  assert.equal((await restoreBackup(pack,'merge')).applications,0);
});
test('Gmail auto-read is per message, commit-before-modify, and idempotent for replayed history',async()=>{
  const {application}=await saveApplication(fixtureJob);
  await updateSettings({gmail:true,markRead:true,gmailDays:14});
  const examples={
    m1:{...fixtureMail,at:new Date().toISOString()},
    m2:{...fixtureMail,id:'m2',threadId:'thread2',subject:'CodeSignal assessment invitation',snippet:'Please complete by 2026-12-05 at 10:00 EST.',at:new Date().toISOString()},
    m3:{...fixtureMail,id:'m3',threadId:'thread3',subject:'Acme Health recruitment next steps',snippet:'Please respond about your application.',at:new Date().toISOString()}
  };
  const modified=[];
  let reads=0,notifies=0;
  const api=async (path,args={})=>{
    if(path==='/profile')return {historyId:'100'};
    if(path==='/history')return {historyId:'101',history:[{messagesAdded:Object.keys(examples).map(id=>({message:{id}}))}]};
    if(path==='/messages')return {messages:Object.keys(examples).map(id=>({id}))};
    const id=path.split('/')[2],row=examples[id];
    if(path.endsWith('/modify')) {
      assert.equal(id,'m1');assert.deepEqual(args.body,{removeLabelIds:['UNREAD']});
      assert.equal((await db.events.get('gmail:'+id)).applicationId,application.id);
      assert.equal((await db.applications.get(application.id)).status,'Applied');
      modified.push(id);return {};
    }
    assert.equal(args.query.format,'full');
    assert.ok(!/body|parts|raw|attachments/.test(args.query.fields));
    reads++;
    return {id,threadId:row.threadId,internalDate:String(Date.parse(row.at)),snippet:row.snippet,labelIds:['UNREAD'],
      payload:{headers:[{name:'Subject',value:row.subject},{name:'From',value:row.from}]}};
  };
  const config=await settings();
  await syncMail({config,api,notify:()=>{notifies++;}});
  await syncMail({config,api,notify:()=>{notifies++;}});
  assert.deepEqual(modified,['m1']);assert.equal(reads,3);assert.equal(notifies,2);
  const actions=await db.events.filter(e=>e.urgent).toArray();
  assert.equal(actions.length,2);assert.ok(actions.every(e=>!e.pendingRead&&!e.applicationId));
});
test('company alone does not link multiple or single applications',async()=>{
  const examples=[{...fixtureJob,id:'a',createdAt:'2026-11-19T00:00:00Z'},
    {...fixtureJob,id:'b',title:'Data scientist',requisition:'REQ-1235',createdAt:'2026-11-19T00:00:00Z'}];
  assert.equal(linkMail(fixtureMail,examples).id,'a');
  assert.equal(linkMail({...fixtureMail,subject:'From Acme Health',snippet:'Please give us availability.'},examples),null);
  const action={...fixtureMail,subject:'Your offer letter',snippet:'Please sign by November 25, 2026 at 9:00 EST.'};
  const event=mailEvent(action,classifyMail(action),null);
  assert.equal(event.urgent,true);assert.equal(event.pendingRead,false);assert.equal(event.deadline.timezone,'EST');
});
test('Claude reserves budget, caps search tool uses, and reconciles actual estimated cost',async()=>{
  const config=await updateSettings({budget:.08,dailyBudget:.08,runBudget:.08,searchesPerRound:3});
  let calls=0;
  const fetcher=async (url,req)=>{
    calls++;
    const body=JSON.parse(req.body);
    assert.equal(body.tools[0].max_uses,3);
    assert.equal(req.headers['x-api-key'],'fixture-key');
    return Response.json({usage:{input_tokens:1000,output_tokens:900,server_tool_use:{web_search_requests:2}},stop_reason:'end_turn',content:[
      {type:'server_tool_use',name:'web_search'},
      {type:'text',text:JSON.stringify({jobs:[{title:'Teacher',company:'North District',location:'Remote',url:'https://jobs.example.com/vacancy/4',evidence:'Official source link'}]})}
    ]});
  };
  const claude=newClaude({config,key:'fixture-key',generation:0,fetcher});
  assert.equal((await claude.searchJobs({titles:['Teacher']})).length,1);
  assert.ok((await db.usage.toArray())[0].cost<.03);
  await updateSettings({budget:0});
  await assert.rejects(()=>claude.searchJobs({titles:['Teacher']}),/budget/);
  assert.equal(calls,1);
});
test('cohorts count distinct submitted applications and use event history',async()=>{
  const first=(await saveApplication(fixtureJob)).application;
  await changeStage(first.id,'Applied');
  await appendEvent({id:'screen-1',applicationId:first.id,kind:'email',stage:'Interview'});
  await appendEvent({id:'screen-2',applicationId:first.id,kind:'email',stage:'Interview'});
  const second=(await saveApplication({...fixtureJob,title:'Nurse',url:fixtureJob.url+'5'})).application;
  await changeStage(second.id,'Interview');
  const data=analyze({applications:await db.applications.toArray(),events:await db.events.toArray(),jobs:[],sources:[],usage:[]});
  assert.equal(data.overall.applications,1);assert.equal(data.overall.interviews,1);assert.equal(data.drafts,1);
});

test('mode changes abort running attempts and suppress later request or notification starts',async()=>{
  const calls=[];
  const state={alarm:false,badge:null};
  globalThis.chrome={
    permissions:{contains:async()=>true},
    alarms:{get:async()=>state.alarm,create:async()=>{state.alarm=true;},clear:async()=>{state.alarm=false;}},
    action:{setBadgeBackgroundColor:async()=>{},setBadgeText:async({text})=>{state.badge=text;}},
    notifications:{getAll:async()=>({'meshjob:job:example':true}),clear:async id=>{calls.push('clear:'+id);return true;},
      create:async id=>{calls.push('notify:'+id);return id;}}
  };
  const originalFetch=globalThis.fetch;
  let request;
  const started=new Promise(resolve=>{request=resolve;});
  globalThis.fetch=async (_url,{signal})=>{
    calls.push('fetch');request();
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  try {
    const {runSource,setMode,notifyUrgent,arm,scopedFetch}=await import('../src/service.js');
    await db.sources.add(source);
    await appendEvent({id:'urgent-1',kind:'email',urgent:true,subject:'Schedule your interview'});
    await arm(); assert.equal(state.alarm,true);
    const running=runSource(source.id,{generation:0});
    const cancelled=assert.rejects(running,/abort/i);
    await started;
    await setMode('Paused');await cancelled;
    await notifyUrgent(0);await notifyUrgent(null);
    await assert.rejects(()=>scopedFetch(0)(source.endpoint),/stopped/);
    assert.deepEqual(calls,['fetch','clear:meshjob:job:example']);assert.equal(state.badge,'');assert.equal(state.alarm,false);
    await setMode('Finished');
    assert.equal((await settings()).mode,'Finished');
    assert.equal((await settings()).generation,2);
    assert.equal((await db.sources.get(source.id)).lastCompleteAt,undefined);
  } finally {globalThis.fetch=originalFetch;delete globalThis.chrome;}
});

test('cross-source aliases converge and same-title different requisitions remain distinct',async()=>{
  const list=detectSource('https://github.com/example/jobs');
  await db.sources.bulkAdd([source,list]);
  const official=row(123);
  await saveSnapshot(list,{items:[{...official,key:list.id+':123',keys:[list.id+':123',...official.keys],official:false}]},0);
  await saveSnapshot(source,{items:[official,row(124)]},0);
  assert.equal(await db.jobs.count(),2);
  const actual=await db.jobs.where('keys').equals(official.key).first();
  assert.ok(actual.official);assert.equal(actual.sourceIds.length,2);
  const rows=await Promise.all([
    saveApplication({company:'Example',title:'Data analyst',url:official.url},{stage:'Preparing'}),
    saveApplication({company:'Example',title:'Data analyst',url:official.url},{stage:'Preparing'})
  ]);
  assert.equal(rows[0].application.id,rows[1].application.id);
  assert.equal(await db.applications.count(),1);
});

test('Gmail cursor recovers from expired history and leaves mailbox unchanged in read-only mode',async()=>{
  await updateSettings({gmail:true,markRead:false,gmailDays:7});
  await db.runtime.put({id:'gmail-cursor',kind:'gmail',base:'old',recover:false});
  const calls=[];
  const request=async (path,{query}={})=>{
    calls.push(path);
    if(path==='/history'){const error=new Error('expired');error.status=404;throw error;}
    if(path==='/profile') return {historyId:'recent'};
    if(path==='/messages'){
      assert.match(query.q,/after:\d+/);assert.match(query.q,/-in:spam/);
      return {messages:[]};
    }
    throw new Error('unexpected request');
  };
  await syncMail({config:await settings(),api:request});
  assert.deepEqual(calls,['/history','/profile','/messages']);
  assert.equal((await db.runtime.get('gmail-cursor')).base,'recent');
  assert.equal((await db.runtime.get('gmail-cursor')).recover,false);
});
