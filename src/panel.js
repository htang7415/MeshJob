import { liveQuery } from 'dexie';
import { db, settings } from './db.js';
import { ATS_ORIGINS, canonicalUrl, freshness, httpUrl, levelOf, normalized, preferenceDecision, workdayTenant } from './domain.js';
import { createFillPlan, fieldQuestion, registrationEmailField } from './form-rules.js';
import { currentMaterials, versionLabel } from './materials.js';
import { LEVELS } from './preferences.js';
import { postingIdentity } from './sources.js';
import { appendEvent, changeStage, findJob, saveApplication, SOURCE_CHOICES } from './tracker.js';
import { badge, button, el, input, paragraph, permit, rpc, select, task, toast } from './ui.js';

// One state at a time, derived from the active tab (spec 2): home · access · posting · form.
const root=document.getElementById('app');
const state={tab:null,inspection:null,app:null,job:null,related:null,config:null,materials:[],answers:[],selected:{resume:'',cover:''},
  draft:{},editing:false,suggestions:null,approved:new Set(),coverText:'',result:null,busy:false,cancelled:false,issue:'',loading:true,
  siteAllowed:false,revision:0,claude:false,home:null,learn:null};
let panelWindow, activeTab, watchedTab, lastPage;
const watchPorts=new Map();
let scanQueued=false, scanPending=false, autoScanning=false;

const pageRef=()=>({tabId:state.tab.id,page:state.inspection.page,revision:state.inspection.revision,
  documentId:state.inspection.formDocumentId,applicationId:state.app?.id});
const requiredOpen=fields=>fields.filter(row=>row.required&&!row.disabled&&!row.filled);
const fullView=hash=>rpc('dashboard',{hash});
const shortDate=value=>value?new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value)):'';
function sameJob(left,right) {
  if(!left||!right) return false;
  const identity=postingIdentity(left);
  const canonical=canonicalUrl(left);
  return !!canonical && canonical===canonicalUrl(right) || !!identity && identity.key===postingIdentity(right)?.key;
}
function clearJob() {
  Object.assign(state,{app:null,result:null,related:null,job:null,suggestions:null,approved:new Set(),coverText:'',draft:{},editing:false,learn:null});
  state.selected={resume:'',cover:''};
}
function watch(tabId,documentId) {
  const targets=tabId==null?[]:[0,...(documentId?[documentId]:[])];
  for(const [target,port] of watchPorts) {
    if(watchedTab!==tabId||!targets.includes(target)) {watchPorts.delete(target);port.disconnect();}
  }
  watchedTab=tabId;
  for(const target of targets) {
    if(watchPorts.has(target)) continue;
    const port=chrome.tabs.connect(tabId,{name:'meshjob:watch',...(target===0?{frameId:0}:{documentId:target})});
    watchPorts.set(target,port);
    port.onMessage.addListener(message=>{if(watchPorts.get(target)===port&&message.type==='page:changed') scheduleScan();});
    port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(watchPorts.get(target)===port) watchPorts.delete(target);});
  }
}
let appWatch=null;
// Keep the card current when the Tracker, Gmail or a submit receipt changes this application.
function watchApp(id) {
  if(appWatch?.id===id) return;
  appWatch?.subscription.unsubscribe();
  appWatch=id?{id,subscription:liveQuery(()=>Promise.all([db.applications.get(id),db.runtime.get('learn:'+id)])).subscribe(([app,learn])=>{
    if(state.app?.id!==id||state.busy) return;
    state.app=app??null;state.learn=learn??null;render();
  })}:null;
}
async function refreshApp(id) {
  state.app=id?await db.applications.get(id)??null:null;
  state.learn=state.app?await db.runtime.get('learn:'+state.app.id)??null:null;
  watchApp(state.app?.id);
}
async function scan({keepResult=false}={}) {
  const revision=++state.revision;
  try {
    const [tab]=await chrome.tabs.query({active:true,windowId:panelWindow});
    if(revision!==state.revision || activeTab!=null && tab?.id!==activeTab)return;
    activeTab=tab?.id;
    if(state.tab?.id!==tab?.id || !sameJob(lastPage,tab?.url)) clearJob();
    state.tab=tab;
    const address=httpUrl(tab?.url);
    state.issue='';state.siteAllowed=false;
    if(address?.protocol!=='https:') {state.inspection=null;watch(null);await loadHome();return;}
    const prior=state.inspection;
    const [found,allowed]=await Promise.all([rpc('form:inspect',{tabId:tab.id,watch:true}),
      chrome.permissions.contains({origins:[address.origin+'/*']})]);
    if(revision!==state.revision)return;
    watch(tab.id,found.formDocumentId);
    const identity=postingIdentity(found.job.url);
    const job=await findJob(identity?[identity.key]:[],[canonicalUrl(found.job.url)]).catch(()=>null);
    const appId=found.sessionAppId || (sameJob(lastPage,found.page)?state.app?.id:null);
    const related=job?await db.applications.where('jobId').equals(job.id).first():null;
    await refreshApp(appId||related?.id);
    if(revision!==state.revision)return;
    state.inspection=found;state.siteAllowed=allowed;
    if(!keepResult || prior && (prior.page!==found.page || prior.revision!==found.revision || prior.formDocumentId!==found.formDocumentId)) {
      state.result=null;state.suggestions=null;
    } else if(state.result) {
      state.result={...state.result,fields:found.fields,unresolved:requiredOpen(found.fields)};
    }
    lastPage=found.page;state.job=job;state.related=related;
    chooseDefaults(job);
    if(mode()==='home') await loadHome();
  } catch(error) {
    if(revision!==state.revision)return;
    state.inspection=null;state.issue=error.message;
    await loadHome();
  } finally {
    if(revision===state.revision) {state.loading=false;render();}
  }
}
function chooseDefaults(job) {
  for (const [type,key] of [['resume','defaultResume'],['cover','defaultCover']]) {
    const used=state.app?.materials?.[type]?.id;
    const matchId=type==='resume'?job?.match?.resumeId:job?.match?.coverId;
    const options=state.materials.filter(row=>row.type===type);
    if(state.selected[type]&&options.some(row=>row.id===state.selected[type])) continue;
    state.selected[type]=[used,matchId,state.config[key],type==='resume'?options[0]?.id:''].find(id=>id&&options.some(row=>row.id===id))??'';
  }
}
async function refreshStatus() {
  const status=await rpc('integrations:status').catch(()=>({}));
  state.claude=!!status.claude;state.atsAccess=!!status.atsAccess;
}
async function initialize() {
  let window;
  [state.config,state.materials,state.answers,window]=await Promise.all([settings(),db.materials.toArray(),db.answers.toArray(),chrome.windows.getCurrent()]);
  state.materials=currentMaterials(state.materials);
  await refreshStatus();
  panelWindow=window.id;
  chooseDefaults();
  await scan();
}

function mode() {
  if(state.loading) return 'loading';
  const found=state.inspection;
  if(!found) return httpUrl(state.tab?.url)?.protocol==='https:'&&state.issue||state.tab?.id!=null&&!state.tab.url?'access':'home';
  if(found.fields.length||found.embedded||found.registration) return 'form';
  if(found.job.title&&(postingIdentity(found.page)||found.job.jd)) return 'posting';
  return 'home';
}
async function loadHome() {
  const [config,events,jobs,apps]=await Promise.all([settings(),db.events.toArray(),
    db.jobs.filter(job=>job.active&&job.official&&!job.hidden).toArray(),db.applications.toArray()]);
  const undone=new Set(events.filter(event=>event.kind==='undo').map(event=>event.reverses));
  const tracked=new Set(apps.map(app=>app.jobId));
  const age=job=>freshness(job,config.preferences.freshnessHours);
  state.home={
    actions:events.filter(event=>event.urgent&&!event.resolvedAt&&!event.acknowledgedAt&&!undone.has(event.id)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,3),
    jobs:jobs.filter(job=>!tracked.has(job.id)&&['verified','detected'].includes(age(job))&&preferenceDecision(job,config.preferences).eligible)
      .sort((a,b)=>(b.postedAt||b.firstSeenAt).localeCompare(a.postedAt||a.firstSeenAt)).slice(0,5),
    apps:apps.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,3)
  };
}

function draftCompany(existing) {
  const found=state.inspection?.job;
  const tenant=workdayTenant(httpUrl(found?.url)?.hostname);
  return [state.draft.company,existing?.company,found?.company,state.job?.company]
    .find(name=>name && (!tenant || normalized(name)!==normalized(tenant)))??'';
}
function draftJob(existing=state.app??state.related) {
  const j=state.job??{}, from=state.inspection?.job??{};
  const title=state.draft.title||existing?.title||from.title||j.title||'';
  return {
    company:draftCompany(existing),title,
    url:existing?.url||from.url||j.url||state.tab?.url||'',
    location:existing?.location||from.location||j.location||'',
    requisition:existing?.requisition||from.requisition||j.requisition||'',
    seniority:state.draft.seniority??existing?.seniority??(j.seniority||levelOf(title)),
    attribution:state.draft.source??existing?.source??from.attribution??''
  };
}
async function ensureApp(stage='Preparing') {
  if(state.app) return state.app;
  const {inspection,tab}=state;
  const job=draftJob();
  if(!job.company||!job.title) {state.editing=true;render();throw new Error('Add the company and job title to track this job.');}
  const result=await rpc('form:prepare',{tabId:tab.id,inspection,job,existingId:state.related?.id,stage});
  if(tab.id!==activeTab || inspection.page!==state.inspection?.page) return null;
  await refreshApp(result.application.id);state.related=state.app;
  return state.app;
}
async function updateDetails(change) {
  Object.assign(state.draft,change);
  if(state.app) {
    const job=draftJob();
    await saveApplication({...job,source:job.attribution},{existingId:state.app.id});
    await refreshApp(state.app.id);
  }
  render();
}
const reference=type=>state.materials.find(item=>item.id===state.selected[type]&&item.type===type);
async function serializedFile(type) {
  const material=reference(type);
  if(!material) return null;
  if(material.blob.size>24_000_000) throw new Error(material.name+' is too large to attach automatically. Upload it on the page.');
  const data=new Uint8Array(await material.blob.arrayBuffer());
  let binary='';
  for(let offset=0;offset<data.length;offset+=0x4000) binary+=String.fromCharCode(...data.subarray(offset,offset+0x4000));
  return {name:material.name,data:btoa(binary)};
}
async function busyWith(fn) {
  if(state.busy) return;
  state.busy=true;state.cancelled=false;render();
  try {return await fn();}
  catch(error) {if(!state.cancelled)throw error;}
  finally {state.busy=false;render();if(scanPending)scheduleScan();}
}
const needsType=(fields,type)=>fields.some(row=>row.type==='file'&&!row.filled&&
  new RegExp(type==='resume'?'resume|résumé|curriculum vitae|\\bcv\\b':'cover letter','i').test(row.label+' '+row.name));
// Fill, let the page reveal follow-up questions, and fill again (at most three passes).
async function fillPage() {
  await scan({keepResult:true});
  const found=state.inspection;
  if(!found||state.cancelled) return;
  if(found.challenge||found.login||found.receipt) return;
  if(!found.fields.length) throw new Error('Open the application form to continue.');
  const app=await ensureApp();
  if(!app||state.cancelled) return;
  const ref=pageRef();
  let fields=found.fields;
  const profile=state.config.profile;
  if(found.job.provider==='workday'&&normalized(found.step)==='my experience'&&(profile.experience?.length||profile.education?.length)) fields=await rpc('form:rows',ref);
  const attempted=new Set();
  let result=null;
  for(let pass=0;pass<3&&!state.cancelled;pass++) {
    const pending=(found.registration?fields.filter(row=>!registrationEmailField(row)):fields).filter(row=>!attempted.has(row.id));
    const plan=createFillPlan(pending,{profile,answers:state.answers,job:app,materials:{
      resume:pass===0&&needsType(fields,'resume')?await serializedFile('resume'):null,
      cover:pass===0&&needsType(fields,'cover')?await serializedFile('cover'):null,coverText:state.coverText}});
    if(!plan.length) break;
    plan.forEach(entry=>attempted.add(entry.id));
    const next=await rpc('form:fill',{...ref,applicationId:app.id,plan,materials:state.selected});
    result=result?{...next,results:[...result.results,...next.results]}:next;
    fields=next.fields;
    if(next.challenge||next.cancelled) break;
  }
  if(activeTab!==ref.tabId||state.inspection?.page!==ref.page) return;
  result??={results:[],fields,unresolved:requiredOpen(fields),errors:0};
  state.result=result;state.inspection.fields=result.fields;
  await refreshApp(app.id);
  const filled=result.results.filter(row=>row.state==='filled').length;
  toast(result.challenge?'Paused for verification.':result.cancelled?'Stopped. Review the page.':filled?filled+' fields filled.':'Nothing new to fill.');
}
async function stopFill() {
  state.cancelled=true;
  await rpc('form:stop',{tabId:state.tab.id,documentId:state.inspection?.formDocumentId});
}
async function suggest() {
  await busyWith(async()=>{
    const app=await ensureApp();
    const fields=state.inspection.fields.filter(row=>!row.filled&&!row.disabled&&!row.critical&&!row.consent);
    const rows=await rpc('form:ai',{...pageRef(),applicationId:app.id,fields});
    const labels=new Map(fields.map(row=>[row.id,row.label]));
    state.suggestions=rows.map(row=>({...row,label:labels.get(row.id)}));
    state.approved=new Set();
    if(!rows.length) toast('No suggestions are supported by your profile.');
  });
}
async function fillApproved() {
  await busyWith(async()=>{
    const plan=state.suggestions.filter(row=>state.approved.has(row.id)).map(row=>({id:row.id,value:row.value,authority:'reviewed'}));
    if(!plan.length) throw new Error('Choose at least one suggestion.');
    const result=await rpc('form:fill',{...pageRef(),plan,materials:state.selected});
    state.result={...result,results:[...(state.result?.results??[]),...result.results]};
    state.inspection.fields=result.fields;state.suggestions=null;
  });
}
async function focusField(id) {
  await rpc('form:focus',{tabId:state.tab.id,page:state.inspection.page,documentId:state.inspection.formDocumentId,id});
}
async function submitted(yes) {
  const id=state.app.id;
  if(yes) await changeStage(id,'Applied');
  else await appendEvent({id:'submission-reset:'+id+':'+Date.now(),applicationId:id,kind:'submission-reset'});
  await refreshApp(id);render();
}

// ---- Views ----
function jobCard(app) {
  const job=draftJob(app);
  const levelSelect=select('level',[['','Not set'],...LEVELS,...(job.seniority&&!LEVELS.includes(job.seniority)?[job.seniority]:[])],job.seniority||'',{'aria-label':'Level'});
  levelSelect.addEventListener('change',task(()=>updateDetails({seniority:levelSelect.value})));
  const source=input('source',job.attribution||'',{list:'source-choices',placeholder:'Source','aria-label':'Source'});
  source.addEventListener('change',task(()=>updateDetails({source:source.value.trim()})));
  const resumes=state.materials.filter(row=>row.type==='resume');
  const resume=select('resume',[['','No resume'],...resumes.map(row=>[row.id,versionLabel(row)])],state.selected.resume,{'aria-label':'Resume'});
  resume.addEventListener('change',()=>{state.selected.resume=resume.value;render();});
  const details=state.editing?el('div',{class:'stack compact'},
    input('company',job.company,{placeholder:'Company','aria-label':'Company'}),input('title',job.title,{placeholder:'Job title','aria-label':'Job title'}),
    button('Done',task(async event=>{
      const box=event.currentTarget.parentElement;
      state.editing=false;
      await updateDetails({company:box.querySelector('[name=company]').value.trim(),title:box.querySelector('[name=title]').value.trim()});
    }),'primary small')):
    el('div',{class:'card-head'},el('div',{},el('h1',{},job.title||'Untitled job'),paragraph(job.company||'Add company','subtle')),
      button('Edit',()=>{state.editing=true;render();},'quiet small',{'aria-label':'Edit company and title'}));
  return el('section',{class:'card'},details,
    el('dl',{class:'rows'},
      el('div',{},el('dt',{},'Level'),el('dd',{},levelSelect)),
      el('div',{},el('dt',{},'Source'),el('dd',{},source,el('datalist',{id:'source-choices'},SOURCE_CHOICES.map(value=>el('option',{value}))))),
      mode()==='form'&&el('div',{},el('dt',{},'Resume'),el('dd',{},resumes.length?resume:button('Add a resume',task(()=>fullView('#settings')),'quiet small'))),
      app?.status&&el('div',{},el('dt',{},'Status'),el('dd',{},badge(app.status,['Rejected','Withdrawn'].includes(app.status)?'muted':'ok')))));
}
function list(title,items) {
  return items.length>0&&el('section',{class:'group'},el('h2',{},title),el('ul',{class:'inset'},items));
}
function homeView() {
  const home=state.home??{actions:[],jobs:[],apps:[]};
  const item=(main,meta,onclick)=>el('li',{},el('button',{type:'button',class:'row-button',onclick},el('span',{},main),meta&&el('small',{},meta)));
  const sections=[
    list('Needs attention',home.actions.map(event=>item(event.subject||'Recruiting message',shortDate(event.at),task(()=>fullView('#tracker/actions'))))),
    list('New jobs',home.jobs.map(job=>item(job.title,job.company,()=>chrome.tabs.create({url:job.url})))),
    list('Recent applications',home.apps.map(app=>item(app.company+' · '+app.title,app.status,task(()=>fullView('#tracker/'+app.id)))))
  ].filter(Boolean);
  return [...sections,!sections.length&&paragraph('Open a job page. MeshJob fills the application and tracks it here.','empty-line')];
}
function accessView() {
  // Without host access Chrome hides the URL. One grant covers every supported ATS; elsewhere the toolbar icon grants this tab.
  if(!state.tab?.url) return [el('section',{class:'group'},
    !state.atsAccess&&el('div',{class:'stack compact'},el('h1',{},'Read job pages automatically'),
      paragraph('Allow MeshJob on Greenhouse, Ashby, Lever, Workday, SmartRecruiters and Workable. The panel then follows job pages and forms without extra clicks.','subtle'),
      button('Allow on job sites',task(async()=>{await permit(ATS_ORIGINS);await refreshStatus();await scan();}),'primary wide')),
    paragraph(state.atsAccess?'Click the MeshJob toolbar icon to read this page.':'On other sites, click the MeshJob toolbar icon.','empty-line'))];
  return [el('section',{class:'group'},paragraph('MeshJob needs access to read this page.','empty-line'),
    button('Allow on this site',task(async()=>{
      const current=httpUrl(state.tab?.url);
      await permit([current.origin+'/*']);await scan();
    }),'primary wide'))];
}
function postingView() {
  const app=state.app??state.related;
  return [jobCard(app),
    app?el('div',{class:'actions'},button('Open in Full view',task(()=>fullView('#tracker/'+app.id)),'wide')):
      button('Save to Tracker',task(async()=>{await ensureApp('Saved');render();toast('Saved to Tracker.');}),'primary wide'),
    submissionView(),learnView()];
}
function submissionView() {
  const app=state.app;
  if(!app) return null;
  if(app.appliedAt) return el('section',{class:'group'},el('p',{class:'done'},'Applied · '+shortDate(app.appliedAt)));
  if(app.submission==='needs_check') return el('section',{class:'group'},el('div',{class:'inline-question'},el('span',{},'Submitted?'),
    button('Yes',task(()=>submitted(true)),'primary small'),button('No',task(()=>submitted(false)),'small')));
  return null;
}
function learnView() {
  const known=new Set(state.answers.map(row=>row.questionKey));
  const rows=(state.learn?.answers??[]).filter(row=>!known.has(fieldQuestion(row.question)));
  if(!rows.length) return null;
  const boxes=rows.map((row,i)=>el('label',{class:'check'},input('learn-'+i,'1',{type:'checkbox',checked:!row.critical}),
    el('span',{},el('strong',{},row.question),el('small',{class:'block'},row.value))));
  return el('section',{class:'group'},el('h2',{},'Save '+rows.length+' answers for next time?'),el('div',{class:'inset padded stack'},boxes),
    el('div',{class:'actions'},button('Save',task(async()=>{
      const chosen=rows.filter((_,i)=>boxes[i].querySelector('input').checked);
      await rpc('answers:save',{applicationId:state.app.id,answers:chosen});
      state.answers=await db.answers.toArray();state.learn=null;render();toast(chosen.length+' answers saved.');
    }),'primary small'),button('Not now',task(async()=>{await db.runtime.delete('learn:'+state.app.id);state.learn=null;render();}),'small')));
}
function formView() {
  const found=state.inspection;
  const {fields,challenge,login,registration,receipt,embedded,embedAccess}=found;
  const open=requiredOpen(fields);
  const result=state.result;
  const failed=result?.results.filter(row=>row.state==='failed')??[];
  const filled=result?.results.filter(row=>row.state==='filled')??[];
  const optional=fields.filter(row=>!row.filled&&!row.disabled&&!row.required&&!row.critical&&!row.consent&&!['file','checkbox'].includes(row.type));
  const notice=(title,text)=>el('div',{class:'notice'},el('strong',{},title),paragraph(text));
  const needsEmbed=embedded&&!embedAccess;
  return [
    challenge&&notice('Verification required','Complete it on the page. MeshJob continues afterwards.'),
    login&&notice('Sign in required','Sign in on the page with Chrome Password Manager.'),
    registration&&notice('Create an account','MeshJob fills your preset email and password. Submit the form yourself; Chrome Password Manager then offers to save the account.'),
    jobCard(state.app),
    el('section',{class:'group'},
      el('p',{class:'progress','aria-live':'polite'},[found.job.provider==='workday'&&found.step,fields.length?fields.length+' fields · '+open.length+' required to fill':'Waiting for the form…'].filter(Boolean).join(' · ')),
      needsEmbed?button('Allow Greenhouse form',task(async()=>{await permit([embedded.origin+'/*'],['webNavigation']);await scan();}),'primary wide'):
        state.busy?el('div',{class:'actions'},el('span',{class:'subtle',role:'status'},'Filling…'),button('Stop',task(stopFill),'small')):
          button(state.app&&found.job.provider==='workday'&&found.step?'Fill this page':'Autofill',task(()=>busyWith(fillPage)),'primary wide',{disabled:!fields.length||challenge||login||!!receipt}),
      registration&&button('Fill sign-up details',task(async()=>{
        await ensureApp();
        const r=await rpc('form:registration',pageRef());toast(r.count?r.count+' sign-up fields filled.':'No empty sign-up fields.');
      }),'wide')),
    open.length>0&&list('Needs you',open.slice(0,30).map(row=>el('li',{},el('button',{type:'button',class:'row-button',onclick:task(()=>focusField(row.id))},
      el('span',{},row.label||'Unlabeled field'),el('small',{},row.critical?'Your answer':row.consent?'Review on page':row.type==='file'?'Upload':''))))),
    state.claude&&result&&optional.length+open.filter(row=>!row.critical&&!row.consent).length>0&&!state.suggestions&&
      button('Suggest answers',task(suggest),'wide',{disabled:state.busy}),
    state.suggestions?.length>0&&el('section',{class:'group'},el('h2',{},'Suggestions'),el('ul',{class:'inset'},state.suggestions.map(row=>
      el('li',{},el('label',{class:'check'},input('approve',row.id,{type:'checkbox',checked:state.approved.has(row.id),
        onchange:event=>{event.target.checked?state.approved.add(row.id):state.approved.delete(row.id);}}),
        el('span',{},el('strong',{},row.label),el('small',{class:'block'},row.value)))))),
      button('Fill selected',task(fillApproved),'primary small')),
    failed.length>0&&list('Could not fill',failed.map(row=>el('li',{},el('span',{},row.label),el('small',{},row.error)))),
    filled.length>0&&el('details',{class:'group'},el('summary',{},filled.length+' filled'),el('ul',{class:'inset'},filled.map(row=>el('li',{},row.label)))),
    submissionView(),learnView()
  ];
}
const workspace=el('main',{class:'workspace panel stack'});
root.append(el('header',{class:'app-header'},el('div',{class:'header-inner'},
  el('span',{class:'brand'},el('img',{alt:'',src:'icons/icon32.png'}),'MeshJob'),
  button('Full view',task(()=>fullView(state.app?'#tracker/'+state.app.id:'')),'quiet small',{title:'Open MeshJob full view'}))),workspace);
function render() {
  const current=mode();
  const content=current==='loading'?el('p',{role:'status',class:'subtle'},'Reading this page…'):
    current==='access'?accessView():current==='posting'?postingView():current==='form'?formView():homeView();
  const focus=document.activeElement;
  const selector=workspace.contains(focus)&&focus.name?`[name="${CSS.escape(focus.name)}"]`:null;
  workspace.dataset.mode=current;
  workspace.replaceChildren(...[content].flat().filter(item=>item instanceof Node));
  if(selector) workspace.querySelector(selector)?.focus({preventScroll:true});
}
render();
void initialize().catch(error=>{state.loading=false;state.issue=error.message;render();}).finally(()=>{if(scanPending)scheduleScan();});
function scheduleScan() {
  scanPending=true;
  if(scanQueued||autoScanning||!state.config)return;
  scanQueued=true;
  queueMicrotask(()=>{
    scanQueued=false;
    if(state.busy||state.editing||document.activeElement?.matches?.('input,select')&&workspace.contains(document.activeElement)) return;
    scanPending=false;autoScanning=true;
    void scan({keepResult:true}).finally(()=>{autoScanning=false;if(scanPending)scheduleScan();});
  });
}
function pageTransition(id,url) {
  const differentTab=activeTab!==id;
  const differentJob=differentTab || url && !sameJob(lastPage,url);
  if(state.busy&&!differentJob)return;
  if(state.busy) {
    state.cancelled=true;
    void rpc('form:stop',{tabId:state.tab.id,documentId:state.inspection?.formDocumentId}).catch(()=>{});
  }
  activeTab=id;
  ++state.revision;
  watch(null);
  if(differentJob) {clearJob();lastPage=null;window.scrollTo(0,0);}
  state.result=null;state.suggestions=null;state.inspection=null;state.loading=true;
  render();
}
chrome.tabs.onActivated.addListener(({tabId,windowId})=>{
  if(windowId!==panelWindow)return;
  pageTransition(tabId);
  scheduleScan();
});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{
  if(tab.windowId!==panelWindow || !tab.active || id!==activeTab)return;
  const changed=change.url && change.url!==lastPage;
  if(change.status==='loading'||changed) pageTransition(id,change.url);
  if(change.url||change.status==='complete') scheduleScan();
});
chrome.tabs.onReplaced.addListener((added,removed)=>{
  if(removed===activeTab) {pageTransition(added);scheduleScan();}
});
chrome.permissions.onAdded.addListener(()=>{void refreshStatus().then(scheduleScan);});
chrome.permissions.onRemoved.addListener(scheduleScan);
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type!=='panel:access'||sender.id!==chrome.runtime.id||message.windowId!==panelWindow) return false;
  if(message.tabId!==activeTab) {pageTransition(message.tabId);}
  scheduleScan();respond(true);
  return false;
});
