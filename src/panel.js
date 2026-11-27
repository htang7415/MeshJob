import { db, settings } from './db.js';
import { canonicalUrl, httpUrl, normalized, workdayTenant } from './domain.js';
import { createFillPlan, PROFILE_KEYS, registrationEmailField } from './form-rules.js';
import { postingIdentity } from './sources.js';
import { changeStage, findJob, saveApplication } from './tracker.js';
import { badge, button, el, field, formDialog, input, paragraph, permit, rpc, section, select, task, toast } from './ui.js';

const root=document.getElementById('app');
const state={tab:null,inspection:null,app:null,job:null,related:null,config:null,materials:[],answers:[],selected:{resume:'',cover:''},
  drafting:[],maps:[],coverText:'',result:null,busy:false,cancelled:false,issue:'',loading:true,siteAllowed:false,revision:0};
let panelWindow, activeTab, watchedTab, lastPage;
const watchPorts=new Map();
let scanQueued=false, scanPending=false, autoScanning=false;

const pageRef=()=>({tabId:state.tab.id,page:state.inspection.page,revision:state.inspection.revision,
  documentId:state.inspection.formDocumentId,applicationId:state.app?.id});
const requiredOpen=fields=>fields.filter(row=>row.required&&!row.disabled&&!row.filled);
const panelName = ()=>el('span',{class:'brand'},el('img',{alt:'',src:'icons/icon32.png'}),'MeshJob');
const refreshDash=()=>rpc('dashboard',{hash:'#tracker'});
function sameJob(left,right) {
  if(!left||!right) return false;
  const identity=postingIdentity(left);
  const canonical=canonicalUrl(left);
  return !!canonical && canonical===canonicalUrl(right) || !!identity && identity.key===postingIdentity(right)?.key;
}
function activeBanner(title,message){
  return el('div',{class:'notice alert stack'},el('h2',{},title),paragraph(message));
}
function clearJob() {
  state.app=null;state.result=null;state.related=null;state.job=null;state.maps=[];state.drafting=[];state.coverText='';
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
    port.onMessage.addListener(message=>{
      if(watchPorts.get(target)===port&&message.type==='page:changed') scheduleScan();
    });
    port.onDisconnect.addListener(()=>{
      void chrome.runtime.lastError;
      if(watchPorts.get(target)===port) watchPorts.delete(target);
    });
  }
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
    state.issue='';
    state.siteAllowed=false;
    if(address?.protocol!=='https:') {state.inspection=null;watch(null);return;}
    const prior=state.inspection;
    const [found,allowed]=await Promise.all([rpc('form:inspect',{tabId:tab.id,watch:true}),
      chrome.permissions.contains({origins:[address.origin+'/*']})]);
    if(revision!==state.revision)return;
    watch(tab.id,found.formDocumentId);
    const identity=postingIdentity(found.job.url);
    const job=await findJob(identity?[identity.key]:[],[canonicalUrl(found.job.url)]).catch(()=>null);
    const appId=found.sessionAppId || (sameJob(lastPage,found.page)?state.app?.id:null);
    const [related,app]=await Promise.all([job?db.applications.where('jobId').equals(job.id).first():null,
      appId?db.applications.get(appId):null]);
    if(revision!==state.revision)return;
    state.inspection=found;
    state.siteAllowed=allowed;
    if(!keepResult || prior && (prior.page!==found.page || prior.revision!==found.revision || prior.formDocumentId!==found.formDocumentId)) {
      state.result=null;state.maps=[];state.drafting=[];
    } else if(state.result) {
      state.result={...state.result,fields:found.fields,unresolved:requiredOpen(found.fields)};
    }
    lastPage=found.page;
    state.job=job;
    state.related=related;
    state.app=app??null;
    chooseDefaults(job);
  } catch(error) {
    if(revision!==state.revision)return;
    state.inspection=null;
    state.issue=error.message;
  } finally {
    if(revision===state.revision) {state.loading=false;render();}
  }
}
function chooseDefaults(job) {
  for (const [type,key] of [['resume','defaultResume'],['cover','defaultCover']]) {
    const matchId=type==='resume'?job?.match?.resumeId:job?.match?.coverId;
    const matches=state.materials.filter(row=>row.type===type);
    const prior=state.selected[type];
    if(prior&&matches.some(row=>row.id===prior)) continue;
    state.selected[type]=[matchId,state.config[key]].find(id=>matches.some(row=>row.id===id))??'';
  }
}
async function initialize() {
  let window;
  [state.config,state.materials,state.answers,window]=await Promise.all([settings(),db.materials.toArray(),db.answers.toArray(),chrome.windows.getCurrent()]);
  panelWindow=window.id;
  chooseDefaults();
  await scan();
}
async function grant() {
  const current=httpUrl(state.tab?.url);
  if(current?.protocol!=='https:') throw new Error('Open a secure HTTPS employer page first.');
  await permit([current.origin+'/*']);
  await scan();
}
async function allowEmbedded() {
  const {embedded}=state.inspection;
  await permit([embedded.origin+'/*'],['webNavigation']);
  await scan();
}
function draftCompany(existing) {
  const found=state.inspection?.job;
  const tenant=workdayTenant(httpUrl(found?.url)?.hostname);
  return [existing?.company,found?.company,state.job?.company]
    .find(name=>name && (!tenant || normalized(name)!==normalized(tenant)))??'';
}
function draftJob(existing) {
  const j=state.job??{};
  const from=state.inspection?.job??{};
  return {
    company:draftCompany(existing),
    title:existing?.title||from.title||j.title||'',
    url:existing?.url||from.url||j.url||state.tab?.url||'',
    location:existing?.location||from.location||j.location||'',
    requisition:existing?.requisition||from.requisition||j.requisition||'',
    attribution:existing?.source||from.attribution||j.attribution||''
  };
}
async function prepare() {
  const {inspection,tab,related}=state;
  const recent=(await db.applications.toArray()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,200);
  if(tab?.id!==activeTab || inspection?.page!==state.inspection?.page) return;
  const job=draftJob(related);
  const f=Object.fromEntries(Object.entries(job).map(([name,value])=>[name,input(name,value,{
    type:name==='url'?'url':'text',required:['company','title'].includes(name)
  })]));
  const association=select('existing',[['','Use this job'],...recent.map(row=>[row.id,row.company+' · '+row.title])],related?.id??'');
  const captured=!!(inspection&&f.company.value&&f.title.value);
  const details=el('div',{class:'form-grid'},field('Company',f.company),field('Job title',f.title),field('Job URL',f.url),
    field('Requisition ID',f.requisition),field('Location',f.location),field('Source',f.attribution));
  formDialog('Prepare application',[
    related&&el('div',{class:'notice alert'},'This requisition is already tracked as '+related.status+'.'),
    captured&&el('div',{class:'stack'},el('strong',{},f.title.value),
      paragraph([f.company.value,f.location.value,f.requisition.value].filter(Boolean).join(' · '),'meta')),
    recent.length>0&&field('Tracked application',association),
    captured?el('details',{},el('summary',{},'Edit job details'),details):details,
    inspection?.job.jd&&paragraph('Job description detected. A copy can be saved locally with this application.','meta')
  ],async values=>{
    const {existing,...job}=values;
    if(existing&&existing!==related?.id) {
      const row=await db.applications.get(existing);
      if(!row)throw new Error('The selected application was removed.');
      Object.assign(job,{company:row.company,title:row.title,url:row.url,requisition:row.requisition,location:row.location,attribution:row.source});
    }
    if(!inspection) {
      const result=await saveApplication(job,{stage:'Preparing',existingId:existing});
      if(tab?.id!==activeTab) return;
      state.app=result.application;state.related=result.application;
      render();toast(result.duplicate?'Existing application opened.':'Preparing draft saved.');
      return;
    }
    if(!job.url) job.url=inspection.page;
    const result=await rpc('form:prepare',{tabId:tab.id,inspection,job,existingId:existing});
    if(tab.id!==activeTab || inspection.page!==state.inspection?.page) return;
    state.app=result.application;state.related=result.application;
    state.result=null;
    render();
    toast(result.duplicate?'Existing application opened.':result.similar?'Preparing draft saved separately from a similar role.':'Preparing draft saved.');
  },'Save draft');
}
function filePicker(type,label) {
  const items=state.materials.filter(row=>row.type===type);
  const control=select(type,[['','No PDF selected'],...items.map(row=>[row.id,row.label])],state.selected[type]);
  control.addEventListener('change',()=>{
    state.selected[type]=control.value;
    if(type==='cover')state.coverText='';
    render();
  });
  return field(label,control);
}
const reference=type=>state.materials.find(item=>item.id===state.selected[type]&&item.type===type);
function coverPreview() {
  const cover=reference('cover');
  if(!cover?.text) return;
  formDialog('Review cover letter text',[
    paragraph('MeshJob can fill a site’s cover-letter text field with the text you approve here. The original PDF remains unchanged.'),
    field('Text to fill',el('textarea',{name:'text',maxlength:6000},state.coverText||cover.text.slice(0,6000)))
  ],async values=>{state.coverText=values.text;render();toast('Cover letter text approved for this form.');},'Approve text');
}
async function serializedFile(type) {
  const material=reference(type);
  if(!material) return null;
  if(material.blob.size>24_000_000) throw new Error(material.name+' is too large for automatic transfer. Upload it manually.');
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
async function fillPage({preview=false,rows=false,silent=false}={}) {
    const ref=pageRef();
    const inspection=state.inspection;
    let app=state.app;
    let fields=inspection.fields;
    if(rows) fields=await rpc('form:rows',ref);
    if(state.cancelled) return null;
    const needsType=type=>fields.some(row=>row.type==='file'&&!row.filled&&new RegExp(type==='resume'?'resume|résumé|curriculum vitae|\\bcv\\b':'cover letter','i').test(row.label+' '+row.name));
    const job=app??draftJob(state.related);
    const fillable=inspection.registration?fields.filter(row=>!registrationEmailField(row)):fields;
    const plan=createFillPlan(fillable,{profile:state.config.profile,answers:state.answers,job,materials:{
      resume:needsType('resume')?await serializedFile('resume'):null,cover:needsType('cover')?await serializedFile('cover'):null,coverText:state.coverText
    },maps:preview?state.maps:[],drafts:preview?state.drafting:[]});
    if(state.cancelled) return null;
    if(!plan.length) {
      state.result={results:[],fields,unresolved:requiredOpen(fields),errors:0,duration:0};
      if(!silent) toast('No verified values are ready to fill. Review the remaining fields.');
      return state.result;
    }
    if(!app) {
      const prepared=await rpc('form:prepare',{tabId:ref.tabId,inspection,job,existingId:state.related?.id});
      if(state.cancelled||activeTab!==ref.tabId||state.inspection?.page!==ref.page) return null;
      app=prepared.application;
      state.app=app;
      state.related=app;
    }
    const result=await rpc('form:fill',{...ref,applicationId:app.id,plan,materials:state.selected});
    const saved=await db.applications.get(app.id);
    if(activeTab!==ref.tabId || state.inspection?.page!==ref.page || state.inspection?.formDocumentId!==ref.documentId) return null;
    state.result=result;
    state.inspection.fields=result.fields;
    state.inspection.challenge||=result.challenge;
    state.app=saved;
    state.maps=[];state.drafting=[];
    if(result.challenge)toast('Autofill paused for verification.');
    else if(result.cancelled)toast('Autofill stopped. Review changes already made on the page.');
    else if(!silent) toast(result.results.filter(row=>row.state==='filled').length+' fields verified on the page.');
    return result;
}
function fillOne(options) {
  return busyWith(async()=>{
    const {tab,inspection}=state;
    await scan({keepResult:true});
    if(state.cancelled||activeTab!==tab.id||!sameJob(inspection.page,state.inspection?.page)) return;
    if(state.inspection.challenge||state.inspection.login||state.inspection.receipt) return;
    if(!state.inspection.fields.length) throw new Error('Open the application form to continue.');
    return fillPage(options);
  });
}
function fillToReview() {
  return busyWith(async()=>{
    for(let stepIndex=0;stepIndex<8&&!state.cancelled;stepIndex++) {
      const form=state.inspection;
      if(!form||form.job.provider!=='workday'||!state.app) break;
      if(/^review(?: your application)?$/i.test(form.step)) {toast('Review step reached. Review and submit in the employer page.');return;}
      if(!/^(?:My Information|My Experience|Application Questions|Additional Questions|Voluntary Disclosures|Self Identification)$/i.test(form.step)||
        form.challenge||form.login||form.registration||form.receipt) break;
      const rows=/^My Experience$/i.test(form.step)&&!!(state.config.profile.education?.length||state.config.profile.experience?.length);
      const result=await fillPage({rows,silent:true});
      if(state.cancelled||result?.cancelled||!result||result.challenge||result.unresolved.length||result.errors||
        result.fields.some(field=>!field.disabled&&(field.consent||field.critical&&!field.filled))) break;
      const next=await rpc('form:advance',pageRef());
      if(next.errors||!next.changed) break;
      await scan({keepResult:true});
    }
    toast(state.cancelled?'Autofill stopped. Review changes already made.':'Review the current step before continuing.');
  });
}
async function stopFill() {
  state.cancelled=true;
  await rpc('form:stop',{tabId:state.tab.id,documentId:state.inspection?.formDocumentId});
}
async function suggest(draft) {
  await busyWith(async()=>{
    const fields=state.inspection.fields.filter(row=>!row.filled&&!row.disabled&&!row.critical&&!row.consent&&row.type!=='skill-picker');
    const results=await rpc('form:ai',{...pageRef(),fields,keys:Object.keys(PROFILE_KEYS),draft});
    if(state.cancelled) return;
    const safeIds=new Set(fields.map(row=>row.id));
    const workable=results.filter(entry=>safeIds.has(entry.id)&&(draft?!!entry.answer:Object.hasOwn(PROFILE_KEYS,entry.key)&&!!state.config.profile[entry.key]));
    if(!workable.length) {toast('No usable suggestions were returned.');return;}
    const checks=workable.map((entry,i)=>{
      const field=fields.find(row=>row.id===entry.id);
      return el('label',{class:'check'},input('include-'+i,'1',{type:'checkbox',checked:false}),
        el('span',{},el('strong',{},field.label),el('span',{class:'stack'},draft?entry.answer:state.config.profile[entry.key]),draft&&entry.facts?.length>0&&el('small',{},entry.facts.join(' · '))));
    });
    formDialog('Review suggestions',[
      paragraph('Compare each value against the form and your own information. Select only values you want MeshJob to fill.'),checks
    ],async values=>{
      const approved=workable.filter((entry,i)=>values['include-'+i]);
      if(!approved.length)throw new Error('Select at least one reviewed suggestion.');
      if(draft)state.drafting=approved;else state.maps=approved;
      await fillOne({preview:true});
    },'Fill selected values');
  });
}
function resultView(result) {
  const filled=result.results.filter(row=>row.state==='filled');
  const failed=result.results.filter(row=>row.state==='failed');
  return section('Review autofill',
    el('div',{class:'stats-inline'},badge(filled.length+' filled','ok'),badge(result.unresolved.length+' required unresolved',result.unresolved.length?'warn':'muted'),
      badge(failed.length+' failed',failed.length?'hot':'muted')),
    result.errors>0&&paragraph('The employer page shows '+result.errors+' validation errors. Review the form.','form-error'),
    result.unresolved.length>0&&el('ul',{class:'form-list'},result.unresolved.slice(0,30).map(row=>
      el('li',{},row.label||'Unlabeled field',row.critical?' · verified answer required':row.consent?' · review in the employer page':''))),
    failed.length>0&&el('ul',{class:'form-list'},failed.map(row=>el('li',{},row.label+' · '+row.error))),
    paragraph('Review the employer form and submit it yourself.','meta'));
}
function applicationView(inspection) {
  const {step,fields,challenge,login,registration,receipt,embedded,embedAccess}=inspection;
  const workday=inspection.job.provider==='workday';
  const prepareRows=workday&&normalized(step)==='my experience'&&!!(state.config.profile.experience?.length||state.config.profile.education?.length);
  const title=state.app?.title||state.job?.title||inspection.job.title||'Application assistant';
  const company=draftCompany(state.app??state.related);
  const canStart=!!state.app||!!(company&&inspection.job.title&&fields.length&&!registration);
  const showMaterials=!!state.app||canStart;
  return [
    el('div',{class:'stack',style:'gap:5px'},el('h1',{},title),company&&paragraph(company),
      el('div',{class:'inline-group'},badge(embedded?'Greenhouse':inspection.job.provider==='generic'?'Generic form':inspection.job.provider),
        state.app&&badge(state.app.status,'ok'),step&&step!==title&&badge(step)),
      !state.siteAllowed&&el('div',{},button('Always scan this site',task(grant),'quiet'))),
    challenge&&activeBanner('Verification required','Complete the verification on the employer page, then continue filling.'),
    login&&activeBanner('Sign-in required','Sign in on the employer page using Chrome Password Manager.'),
    registration&&activeBanner('Registration form','Review credentials and create the account yourself.'),
    !canStart&&section('Track this application',paragraph('Prepare a draft to track this application.'),
      state.related&&badge('Already tracked · '+state.related.status,'warn'),
      button('Prepare application',task(prepare),'primary')),
    (state.app||fields.length>0||embedded)&&section('Autofill',
      fields.length>0&&el('div',{class:'inline-group','aria-live':'polite'},badge(fields.length+' fields detected'),
        badge(requiredOpen(fields).length+' required open','warn')),
      embedded&&!embedAccess?el('div',{class:'stack'},
        paragraph('This application form is hosted by Greenhouse. Allow access so MeshJob can detect its fields as they change.','meta'),
        el('div',{},button('Allow Greenhouse form',task(allowEmbedded),'primary'))):
        fields.length===0&&paragraph(embedded?'Waiting for the Greenhouse form to load.':'Open the application form. MeshJob will detect fields as they appear.','meta'),
      state.busy&&el('p',{class:'meta',role:'status'},'Filling this page…'),
      canStart&&(!embedded||embedAccess)&&el('div',{class:'actions'},button('Fill available fields',task(()=>fillOne()),'primary',{disabled:state.busy||!fields.length||challenge||login||!!receipt}),
        !state.app&&button('Prepare application',task(prepare),'quiet',{disabled:state.busy}),
        state.app&&prepareRows&&button('Add missing rows and fill',task(()=>fillOne({rows:true})),'',{disabled:state.busy||challenge}),
        registration&&button('Fill registration credentials',task(async()=>{
          const r=await rpc('form:registration',pageRef());
          toast(r.count?r.count+' registration fields filled.':'No empty registration fields were filled.');
        }),'',{disabled:state.busy||challenge}),
        button('Scan again',task(()=>scan()),'',{disabled:state.busy}),state.busy&&button('Stop fill',task(stopFill)))),
    showMaterials&&section('Application materials',filePicker('resume','Resume PDF'),filePicker('cover','Cover letter PDF'),
      reference('cover')?.text&&button(state.coverText?'Review approved cover letter text':'Review cover letter text',coverPreview,'quiet')),
    state.result&&resultView(state.result),
    state.app&&state.result?.unresolved?.length>0&&section('Optional Claude suggestions',
      paragraph('Only field labels, options and relevant facts are sent for suggestions. Review each value before applying it.','meta'),
      el('div',{class:'actions'},button('Map remaining fields',task(()=>suggest(false)),'',{disabled:state.busy}),
        button('Draft text answers',task(()=>suggest(true)),'',{disabled:state.busy}))),
    state.app&&workday&&state.config.advance&&!receipt&&section('Workday step',
      paragraph('Fill known steps and stop at review or when the form needs your input.','meta'),
      el('div',{class:'actions'},
        button('Fill to review',task(fillToReview),'',{disabled:state.busy||challenge||login}),
        button('Continue to next step',task(()=>busyWith(async()=>{
          const next=await rpc('form:advance',pageRef());await scan();
          toast(next.changed?'Next step opened.':next.errors?'Review validation errors in the employer tab.':'No new step was detected.');
        })),'',{disabled:state.busy||challenge||login}))),
    state.app&&section('Submission',
      paragraph(state.app.appliedAt?'Submission recorded.':state.app.submission==='needs_check'?'Needs Check · no ATS receipt recorded.':receipt?'A receipt is visible. Confirm it belongs to this application.':'Waiting for a verified receipt or your confirmation.'),
      !state.app.appliedAt&&button('Confirm I submitted',()=>{
        const {id,company}=state.app;
        formDialog('Confirm submission',[paragraph('Confirm that you submitted this application to '+company+'.')],async()=>{
          await changeStage(id,'Applied');
          const updated=await db.applications.get(id);
          if(state.app?.id===id){state.app=updated;render();toast('Submission recorded.');}
        },'Confirm submitted');
      }),
      button('Open Tracker',task(refreshDash),'quiet'))
  ];
}
const workspace=el('main',{class:'workspace stack'});
root.append(el('header',{class:'app-header'},el('div',{class:'header-inner'},panelName(),
  button('Dashboard',task(()=>rpc('dashboard')),'quiet'))),workspace);
function render() {
  const address=httpUrl(state.tab?.url);
  const needsAccess=!state.tab?.url && state.tab?.id!=null;
  const content=state.loading?el('p',{role:'status',class:'meta'},'Scanning the active tab…'):
    state.inspection?applicationView(state.inspection):[
      el('h1',{},'Application assistant'),
      needsAccess?section('Connect this tab',paragraph('On a job page, click the MeshJob toolbar icon to give Chrome permission to scan this tab.')):
        section(address?'Scan this page':'Open a job page',paragraph(state.issue||'Open a job listing or application in the active tab.')),
      el('div',{class:'actions'},address?.protocol==='https:'&&button('Allow this site',task(grant),'primary'),
        address?.protocol==='https:'&&button('Scan again',task(()=>scan())),
        address?.protocol==='https:'&&button('Add manually',task(prepare)),button('Open Tracker',task(refreshDash)))
    ];
  const focus=document.activeElement;
  const selector=workspace.contains(focus)&&focus.name?`[name="${CSS.escape(focus.name)}"]`:null;
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
    if(state.busy||document.querySelector('dialog[open]')) return;
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
  for(const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  state.result=null;state.maps=[];state.drafting=[];
  state.inspection=null;state.loading=true;
  render();
}
document.addEventListener('close',()=>{if(scanPending)scheduleScan();},true);
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
chrome.permissions.onAdded.addListener(scheduleScan);
chrome.permissions.onRemoved.addListener(scheduleScan);
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type!=='panel:access'||sender.id!==chrome.runtime.id||
    message.windowId!==panelWindow||message.tabId!==activeTab) return false;
  scheduleScan();respond(true);
  return false;
});
