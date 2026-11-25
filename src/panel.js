import { db, settings } from './db.js';
import { canonicalUrl, httpUrl, normalized, workdayTenant } from './domain.js';
import { createFillPlan, PROFILE_KEYS } from './form-rules.js';
import { postingIdentity } from './sources.js';
import { changeStage, findJob, saveApplication } from './tracker.js';
import { badge, blank, button, el, field, formDialog, input, link, paragraph, permit, rpc, section, select, task, toast } from './ui.js';

const root=document.getElementById('app');
const state={tab:null,inspection:null,app:null,job:null,related:null,config:null,materials:[],answers:[],selected:{resume:'',cover:''},
  drafting:[],maps:[],coverText:'',result:null,busy:false,cancelled:false,issue:'',initial:true,revision:0};

const pageRef=()=>({tabId:state.tab.id,page:state.inspection.page,revision:state.inspection.revision,applicationId:state.app?.id});
const panelName = ()=>el('span',{class:'brand'},el('img',{alt:'',src:'icons/icon32.png'}),'MeshJob');
const taskAction=(fn,label)=>button(label,task(fn));
const refreshDash=()=>rpc('dashboard',{hash:'#tracker'});
function activeBanner(title,message){
  return el('div',{class:'notice alert stack'},el('h2',{},title),paragraph(message));
}
async function scan({keepResult=false}={}) {
  const revision=++state.revision;
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(revision!==state.revision)return;
  const prior=state.tab;
  state.tab=tab;
  if(prior?.id!==tab?.id || (state.inspection?.page!==tab?.url&&postingIdentity(state.inspection?.page)?.key!==postingIdentity(tab?.url)?.key)) {
    state.app=null;state.result=null;state.related=null;state.job=null;state.maps=[];state.drafting=[];state.coverText='';state.issue='';
  }
  try {
    if(httpUrl(tab?.url)?.protocol!=='https:') throw new Error('Open a job listing or application in the active tab.');
    const found=await rpc('form:inspect',{tabId:tab.id});
    if(revision!==state.revision)return;
    state.inspection=found;
    state.issue='';
    const identity=postingIdentity(found.job.url);
    let job=null;
    try {job=await findJob(identity?[identity.key]:[],[canonicalUrl(found.job.url)]);} catch (error) {state.issue=error.message;}
    const related=job?await db.applications.where('jobId').equals(job.id).first():null;
    if(revision!==state.revision)return;
    state.job=job;
    state.related=related;
    if(found.sessionAppId) state.app=await db.applications.get(found.sessionAppId)??null;
    else if(state.app?.id) state.app=await db.applications.get(state.app.id)??null;
    if(!keepResult) {state.result=null;state.maps=[];state.drafting=[];}
    chooseDefaults(job);
  } catch(error) {
    state.inspection=null;
    state.issue=error.message;
  } finally {
    if(revision===state.revision) {state.initial=false;render();}
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
  [state.config,state.materials,state.answers]=await Promise.all([settings(),db.materials.toArray(),db.answers.toArray()]);
  chooseDefaults();
  await scan();
}
async function grant() {
  const current=httpUrl(state.tab?.url);
  if(current?.protocol!=='https:') throw new Error('Open a secure HTTPS employer page first.');
  await permit([current.origin+'/*']);
  await scan();
}
function draftCompany(existing) {
  const found=state.inspection?.job;
  const tenant=workdayTenant(httpUrl(found?.url)?.hostname);
  return [existing?.company,found?.company,state.job?.company]
    .find(name=>name && (!tenant || normalized(name)!==normalized(tenant)))??'';
}
function getDraftInputs(existing) {
  const j=state.job??state.inspection?.job??{};
  const from=state.inspection?.job??{};
  return {
    company:input('company',draftCompany(existing),{required:true,placeholder:'Enter company name'}),
    title:input('title',existing?.title??j.title??'',{required:true,autocomplete:'off'}),
    url:input('url',existing?.url??j.url??from.url??state.tab?.url??'',{type:'url'}),
    location:input('location',existing?.location??j.location??''),
    requisition:input('requisition',existing?.requisition??j.requisition??''),
    attribution:input('attribution',existing?.source??j.attribution??from.attribution??'')
  };
}
async function prepare() {
  const recent=(await db.applications.toArray()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,200);
  const {inspection,tab,related}=state;
  const f=getDraftInputs(related);
  const association=select('existing',[['','Use this job'],...recent.map(row=>[row.id,row.company+' · '+row.title])],related?.id??'');
  formDialog('Prepare application',[
    related&&el('div',{class:'notice alert'},'This requisition is already tracked as '+related.status+'.'),
    recent.length>0&&field('Tracked application',association),
    el('div',{class:'form-grid'},field('Company',f.company),field('Job title',f.title),field('Job URL',f.url),
      field('Requisition ID',f.requisition),field('Location',f.location),field('Source',f.attribution)),
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
      state.app=result.application;state.related=result.application;
      render();toast(result.duplicate?'Existing application opened.':'Preparing draft saved.');
      return;
    }
    if(!job.url) job.url=inspection.page;
    const result=await rpc('form:prepare',{tabId:tab.id,inspection,job,existingId:existing});
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
  finally {state.busy=false;render();}
}
async function fillPage({preview=false,rows=false,silent=false}={}) {
    const ref=pageRef();
    const inspection=state.inspection;
    let fields=inspection.fields;
    if(rows) fields=await rpc('form:rows',ref);
    const needsType=type=>fields.some(row=>row.type==='file'&&!row.filled&&new RegExp(type==='resume'?'resume|résumé|curriculum vitae|\\bcv\\b':'cover letter','i').test(row.label+' '+row.name));
    const plan=createFillPlan(fields,{profile:state.config.profile,answers:state.answers,job:state.app,materials:{
      resume:needsType('resume')?await serializedFile('resume'):null,cover:needsType('cover')?await serializedFile('cover'):null,coverText:state.coverText
    },maps:preview?state.maps:[],drafts:preview?state.drafting:[]});
    if(state.cancelled) return null;
    if(!plan.length) {
      state.result={results:[],fields,unresolved:fields.filter(row=>row.required&&!row.disabled&&!row.filled),errors:0,duration:0};
      if(!silent) toast('No verified values are ready to fill. Review the remaining fields.');
      return state.result;
    }
    const result=await rpc('form:fill',{...ref,plan,materials:state.selected});
    state.result=result;
    state.inspection.fields=result.fields;
    state.app=await db.applications.get(state.app.id);
    state.maps=[];state.drafting=[];
    if(result.cancelled)toast('Autofill stopped. Review changes already made on the page.');
    else if(!silent) toast(result.results.filter(row=>row.state==='filled').length+' fields verified on the page.');
    return result;
}
function fillOne(options) {return busyWith(()=>fillPage(options));}
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
      if(state.cancelled||result?.cancelled||!result||result.unresolved.length||result.errors||
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
  await rpc('form:stop',{tabId:state.tab.id});
}
async function suggest(draft) {
  await busyWith(async()=>{
    const fields=state.inspection.fields.filter(row=>!row.filled&&!row.disabled&&!row.critical&&!row.consent&&row.type!=='skill-picker');
    const results=await rpc('form:ai',{...pageRef(),fields,keys:Object.keys(PROFILE_KEYS),draft});
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
  const {step,fields,challenge,login,registration,receipt}=inspection;
  const workday=inspection.job.provider==='workday';
  const prepareRows=workday&&normalized(step)==='my experience'&&!!(state.config.profile.experience?.length||state.config.profile.education?.length);
  const title=state.app?.title||state.job?.title||inspection.job.title||'Application assistant';
  const company=draftCompany(state.app??state.related);
  return [
    el('div',{class:'stack',style:'gap:5px'},el('h1',{},title),company&&paragraph(company),
      el('div',{class:'inline-group'},badge(inspection.job.provider==='generic'?'Generic form':inspection.job.provider),
        state.app&&badge(state.app.status,'ok'),step&&step!==title&&badge(step))),
    challenge&&activeBanner('Page challenge','Complete the challenge in the employer tab, then scan again.'),
    login&&activeBanner('Sign-in required','Sign in on the employer page using Chrome Password Manager, then scan again.'),
    registration&&activeBanner('Registration form','Review credentials and create the account yourself.'),
    !state.app&&section('Track this application',paragraph('Save a draft to start autofill on this page.'),
      state.related&&badge('Already tracked · '+state.related.status,'warn'),
      button('Prepare application',task(prepare),'primary')),
    state.app&&section('Application materials',filePicker('resume','Resume PDF'),filePicker('cover','Cover letter PDF'),
      reference('cover')?.text&&button(state.coverText?'Review approved cover letter text':'Review cover letter text',coverPreview,'quiet')),
    state.app&&section('Autofill',
      el('div',{class:'inline-group'},badge(fields.length+' controls'),badge(fields.filter(row=>row.required&&!row.filled&&!row.disabled).length+' required open','warn')),
      fields.length===0&&paragraph('Open the application form and scan again. Embedded forms may need to be opened in their own tab.','meta'),
      el('div',{class:'actions'},button('Fill available fields',task(()=>fillOne()),'primary',{disabled:state.busy||!fields.length||challenge||login||!!receipt}),
        prepareRows&&button('Add missing rows and fill',task(()=>fillOne({rows:true})),'',{disabled:state.busy||challenge}),
        registration&&button('Fill saved password',task(async()=>{const r=await rpc('form:password',pageRef());toast(r.count+' password controls filled.');}),'',{disabled:state.busy}),
        button('Scan again',task(()=>scan()),'',{disabled:state.busy}),state.busy&&button('Stop fill',task(stopFill)))),
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
      !state.app.appliedAt&&button('Confirm I submitted',()=>formDialog('Confirm submission',[
        paragraph('Confirm that you submitted this application to '+state.app.company+'.')
      ],async()=>{await changeStage(state.app.id,'Applied');state.app=await db.applications.get(state.app.id);render();toast('Submission recorded.');},'Confirm submitted')),
      button('Open Tracker',task(refreshDash),'quiet'))
  ];
}
function render() {
  const content=state.initial?paragraph('Scanning the active tab…'):state.inspection?applicationView(state.inspection):[
    el('h1',{},'Application assistant'),
    blank('Open an application tab',state.issue||'Scan a listing or application form to get started.'),
    el('div',{class:'actions'},httpUrl(state.tab?.url)?.protocol==='https:'&&button('Grant page access',task(grant),'primary'),
      httpUrl(state.tab?.url)&&button('Add manually',task(prepare)),button('Open Tracker',task(refreshDash)))
  ];
  root.replaceChildren(el('header',{class:'app-header'},el('div',{class:'header-inner'},panelName(),
    button('Dashboard',task(()=>rpc('dashboard')),'quiet'))),
    el('main',{class:'workspace stack'},content));
}
render();
void initialize().catch(error=>{state.initial=false;state.issue=error.message;render();});
let scanTimer;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer=setTimeout(()=>{if(!state.busy&&!document.querySelector('dialog[open]'))void scan({keepResult:true});},200);
}
chrome.tabs.onActivated.addListener(scheduleScan);
chrome.tabs.onUpdated.addListener((id,change)=>{
  if(id===state.tab?.id&&change.status==='complete')scheduleScan();
});
