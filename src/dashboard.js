import { liveQuery } from 'dexie';
import { db, settings } from './db.js';
import { distinctValues, freshness, httpUrl, JOB_DESCRIPTION_LIMIT, normalized, preferenceDecision, STAGES, uid } from './domain.js';
import { BOARD_API_ORIGINS, detectSource } from './sources.js';
import { analyze, statsPeriod } from './stats.js';
import { changeStage, deleteApplication, saveApplication, SOURCE_CHOICES, undoEvent } from './tracker.js';
import { applicationCSV, csvPreview, eventsCSV, importApplicationCSV, jobsCSV, makeBackup, readSources, sourcePack, sourcesCSV } from './portability.js';
import { blank,badge,button,check,dataTable,dateLabel,download,el,field,formDialog,input,link,paragraph,permit,readTokens,rpc,section,select,task,textarea,toast,tokenField } from './ui.js';
import { addMailDialog, profileView } from './profile.js';
import { materialFor, versionLabel } from './materials.js';
import { COUNTRY_OPTIONS, EMPLOYMENT_TYPES, LEVELS, normalizeLevels, PRIORITIES, regionOptions, WORKPLACE_TYPES } from './preferences.js';

const root=document.querySelector('#app');
const tabs=['Discover','Tracker','Stats','Settings'];
const view={query:'',sort:'recent',includeUndated:false,includeApplied:false,showHidden:false,
  trackQuery:'',stage:'',includeResolved:false,trackerMode:'table',statsRange:'all',limit:70};
let main,nav,banner,inspector,subscription,routeData,routeKey,openedDetail;
const selected=()=>{
  const key=location.hash.slice(1).split('/')[0];
  return key==='profile'?'Settings':tabs.find(title=>title.toLowerCase()===key)??'Discover';
};
const detail=()=>decodeURIComponent(location.hash.split('/')[1]??'');
const icon=path=>{
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('fill','none');
  svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
  const node=document.createElementNS('http://www.w3.org/2000/svg','path');node.setAttribute('d',path);svg.append(node);
  return svg;
};
const ICONS={Discover:'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',Tracker:'M4 6h16M4 12h16M4 18h10',
  Stats:'M5 20V10m7 10V4m7 16v-7',Settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z'};
const stageStyle=stage=>['Applied','OA','Interview','Offer','Accepted'].includes(stage)?'ok':['Rejected','Withdrawn'].includes(stage)?'muted':'warn';
const smallSearch=(id,value,label,fn)=>input(id,value,{id,type:'search',placeholder:label,'aria-label':label,oninput:event=>fn(event.target.value)});
const origin=url=>new URL(url).origin+'/*';
const relative=value=>{
  const minutes=(Date.now()-Date.parse(value))/60000;
  if(!Number.isFinite(minutes)) return '';
  if(minutes<60) return Math.max(1,Math.round(minutes))+'m ago';
  if(minutes<48*60) return Math.round(minutes/60)+'h ago';
  return Math.round(minutes/1440)+'d ago';
};
const pageHead=(title,subtitle,actions)=>el('header',{class:'page-head'},el('div',{},el('h1',{},title),subtitle&&paragraph(subtitle)),actions&&el('div',{class:'actions'},actions));
const menu=(label,items)=>el('details',{class:'menu'},el('summary',{'aria-label':label,title:label},'⋯'),el('div',{},items.filter(Boolean)));

function runDialog(label,type,args,message) {
  const id=uid();
  const status=el('p',{role:'status'},'Working…');
  let running=true;
  const cancel=button('Cancel',task(async()=>{await rpc('operation:cancel',{op:id});status.textContent='Cancelling…';}));
  const {dialog}=formDialog(label,[status,cancel]);
  dialog.addEventListener('cancel',event=>{if(running) {event.preventDefault();cancel.click();}});
  return rpc(type,{...args,op:id}).then(result=>{
    running=false;status.textContent=message(result);
    cancel.replaceWith(button('Close',()=>dialog.close(),'primary'));
    return result;
  },error=>{
    running=false;status.textContent=error.message;
    cancel.replaceWith(button('Close',()=>dialog.close(),'primary'));
  });
}
// Right-hand inspector instead of modal dialogs (spec 2).
function openInspector(title,children) {
  inspector.replaceChildren(el('div',{class:'inspector-head'},el('h2',{},title),button('×',closeInspector,'icon',{'aria-label':'Close'})),...[children].flat().filter(Boolean));
  inspector.hidden=false;inspector.setAttribute('aria-label',title);
  inspector.querySelector('button')?.focus({preventScroll:true});
}
function closeInspector() {inspector.hidden=true;inspector.replaceChildren();}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!inspector.hidden&&!document.querySelector('dialog[open]')) closeInspector();});
document.addEventListener('click',event=>{
  for(const open of document.querySelectorAll('details.menu[open]')) if(!open.contains(event.target)||event.target.closest('.menu>div .button')) open.open=false;
});
function redrawResults() {
  if(!routeData) return;
  const container=document.getElementById('view-results');
  if(!container) return;
  container.replaceChildren(...(selected()==='Discover'?discoverResults(routeData):trackerResults(routeData)));
}
function navigation() {
  nav=el('nav',{'aria-label':'Main navigation'},tabs.slice(0,3).map(title=>el('a',{href:'#'+title.toLowerCase()},icon(ICONS[title]),title)));
  const settingsLink=el('a',{href:'#settings'},icon(ICONS.Settings),'Settings');
  banner=el('div',{class:'banner',hidden:true});
  main=el('main',{id:'main',class:'workspace',tabindex:'-1'},paragraph('Opening MeshJob…'));
  inspector=el('aside',{class:'inspector',hidden:true,role:'complementary'});
  root.replaceChildren(el('div',{class:'shell'},
    el('aside',{class:'side-nav'},el('a',{class:'brand',href:'#discover'},el('img',{src:'icons/icon32.png',alt:''}),'MeshJob'),nav,el('div',{class:'spacer'}),
      el('nav',{'aria-label':'Settings'},settingsLink)),
    el('div',{},el('div',{class:'workspace',style:'padding-bottom:0'},banner),main)),inspector);
}
async function pageData(tab) {
  const config=await settings();
  if(tab==='Discover') {
    const [jobs,apps,sources,runtime]=await Promise.all([db.jobs.filter(job=>job.active||job.lead||job.hidden).toArray(),db.applications.toArray(),db.sources.toArray(),db.runtime.where('kind').anyOf(['health','suggestion']).toArray()]);
    return {config,jobs,apps,sources,runtime};
  }
  if(tab==='Tracker') {
    const [apps,events]=await Promise.all([db.applications.toArray(),db.events.toArray()]);
    return {config,apps,events};
  }
  if(tab==='Stats') {
    const [applications,events]=await Promise.all([db.applications.toArray(),db.events.toArray()]);
    return {config,applications,events};
  }
  const [materials,answers,health,usage]=await Promise.all([db.materials.filter(row=>!row.archived).toArray(),db.answers.toArray(),db.runtime.get('health:gmail'),db.usage.toArray()]);
  return {config,materials,answers,health,usage};
}
function updateHeader(config) {
  for(const a of root.querySelectorAll('.side-nav nav a')) {
    if(a.textContent===selected())a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  }
  banner.hidden=config.mode==='Active';
  if(config.mode!=='Active') banner.replaceChildren(el('span',{},'Search '+config.mode.toLowerCase()+'. Automatic checks and alerts are off.'),
    button('Search status',()=>searchMode(config),'small',{'aria-label':'Search '+config.mode.toLowerCase()}));
}
function render(data,force=false) {
  const setupChanged=routeData?.config.onboarded!==data.config.onboarded;
  routeData=data;
  updateHeader(data.config);
  const tab=selected();
  const editing=main.contains(document.activeElement)&&document.activeElement?.matches('input,textarea,select,button,a');
  if(!force&&!setupChanged&&editing&&document.querySelector('#view-results')&&tab!=='Settings') {redrawResults();performance.mark('meshjob-render');return;}
  if(!force&&!setupChanged&&tab==='Settings'&&main.contains(document.activeElement)&&document.activeElement?.matches('input,textarea,select')) return;
  const content=tab==='Discover'?discover(data):tab==='Tracker'?tracker(data):tab==='Stats'?stats(data):profileView(data,{backup,storageHelp,searchMode,discoveryPreferences});
  main.replaceChildren(content);
  performance.mark('meshjob-render');
  const target=detail();
  if(target&&openedDetail!==location.hash) {
    openedDetail=location.hash;
    if(tab==='Tracker'&&target!=='actions') {const app=data.apps.find(row=>row.id===target);if(app) void showApplication(app);}
    if(tab==='Tracker'&&target==='actions') document.querySelector('#action-queue')?.scrollIntoView({block:'start'});
    if(tab==='Discover') {const job=data.jobs.find(row=>row.id===target);if(job) jobDetails(job,data.config);}
  }
}
function navigate(force=false) {
  const tab=selected();
  if(routeKey===tab&&!force&&routeData) {render(routeData,true);return;}
  routeKey=tab;routeData=null;view.limit=70;
  subscription?.unsubscribe();
  subscription=liveQuery(()=>pageData(tab)).subscribe({
    next:data=>{if(routeKey===tab)render(data,force);force=false;},
    error:error=>main.replaceChildren(blank('Local database unavailable',error.message,button('Retry',()=>navigate(true))))
  });
}
navigation();
navigate(true);
window.addEventListener('hashchange',()=>{if(location.hash==='#main') return;openedDetail=null;closeInspector();navigate();});

function searchMode(config) {
  const mode=select('mode',['Active','Paused','Finished'],config.mode);
  const {dialog}=formDialog('Search status',[
    field('Mode',mode),paragraph('Paused and Finished stop automatic checks, AI, Gmail sync and alerts. Your data stays available.')
  ],async ({mode})=>{
    if(mode==='Finished'&&config.mode!=='Finished') {dialog.close();await finishSearch();return false;}
    await rpc('mode:set',{mode});toast('Search is '+mode.toLowerCase()+'.');
  },'Update');
}
async function finishSearch() {
  const apps=await db.applications.toArray();
  formDialog('Finish your job search',[
    paragraph('Stop scheduled checks and notifications. Requests already sent may still finish or be billed.'),
    field('Accepted application · optional',select('accepted',[['','Choose an application'],...apps.filter(app=>['Offer','Accepted'].includes(app.status)).map(app=>[app.id,app.company+' · '+app.title])],'')),
    button('Download a backup first',task(backup),''),
    check('confirm','I want to stop scheduled services.')
  ],async ({accepted,confirm})=>{
    if(!confirm) throw new Error('Confirm that you want to stop scheduled services.');
    if(accepted) await changeStage(accepted,'Accepted');
    await rpc('mode:set',{mode:'Finished',confirm:true});
    toast('Search finished. Your data stays available.');
  },'Finish search');
}
async function backup() {
  toast('Preparing a backup with your personal data and PDFs…');
  download('meshjob-backup.zip',await makeBackup(),'application/zip');
  toast('Backup prepared.');
}
function storageHelp() {
  formDialog('Local storage',[
    paragraph('Applications, answers and PDFs stay in this Chrome profile. Export a backup before uninstalling.'),
    button('Download backup',task(backup),'primary')
  ]);
}

const preferenceLists=['titles','countries','locations','seniority','employmentType','workMode'];
const optionalNumber=value=>value===''||value==null?null:Number(value);
function readPreferences(values) {
  return {
    ...Object.fromEntries([...preferenceLists,'excludeTitles','excludeCompanies'].map(key=>[key,readTokens(values,key)])),
    sponsorship:values.sponsorship||'Unspecified',maxYears:optionalNumber(values.maxYears),minimumPay:optionalNumber(values.minimumPay),
    currency:(values.currency||'USD').toUpperCase().slice(0,3),period:values.period||'year',
    ...(values.freshnessHours ? {freshnessHours:Number(values.freshnessHours)} : {})
  };
}
function preferencesForm(p) {
  const countries=distinctValues(p.countries);
  const regions=tokenField('locations','Regions or cities',p.locations,{choices:regionOptions(countries),placeholder:'Add a region, state, or city'});
  const country=tokenField('countries','Countries',countries,{choices:COUNTRY_OPTIONS,custom:false,change:values=>regions.setChoices(regionOptions(values))});
  return el('div',{class:'stack large'},
    tokenField('titles','Target job titles',p.titles,{placeholder:'Software engineer, Data analyst'}).root,
    el('div',{class:'form-grid'},country.root,regions.root,
      tokenField('seniority','Level',normalizeLevels(p.seniority),{choices:LEVELS,custom:false}).root,
      tokenField('workMode','Workplace type',p.workMode,{choices:WORKPLACE_TYPES,custom:false}).root,
      field('Visa sponsorship',select('sponsorship',[['Unspecified','No preference'],'Required','Not required'],p.sponsorship)),
      field('Date posted',select('freshnessHours',[
        ['24','Past 24 hours'],['72','Past 3 days'],['168','Past week'],['720','Past month'],
        ...([24,72,168,720].includes(p.freshnessHours)?[]:[[String(p.freshnessHours),'Past '+p.freshnessHours+' hours']])
      ],String(p.freshnessHours)))),
    el('details',{class:'more'},el('summary',{},'More'),el('div',{class:'form-grid'},
      tokenField('excludeTitles','Exclude title words',p.excludeTitles,{placeholder:'Senior, Manager'}).root,
      tokenField('excludeCompanies','Exclude companies',p.excludeCompanies,{}).root,
      field('Maximum years required',input('maxYears',p.maxYears??'',{type:'number',min:0,max:40,placeholder:'Any'})),
      tokenField('employmentType','Employment type',p.employmentType,{choices:EMPLOYMENT_TYPES,custom:false}).root,
      field('Minimum pay',input('minimumPay',p.minimumPay??'',{type:'number',min:0,placeholder:'Any'})),
      el('div',{class:'form-grid'},field('Currency',input('currency',p.currency??'USD',{maxlength:3})),
        field('Per',select('period',[['year','Year'],['month','Month'],['hour','Hour']],p.period??'year')))))
  );
}
function discoveryPreferences(setup=false) {
  const config=routeData.config;
  formDialog(setup?'Set up discovery':'Preferences',[
    preferencesForm(config.preferences),
    el('div',{class:'stack compact'},
      check('undated','Include jobs without a posting date',view.includeUndated),
      check('applied','Show tracked jobs',view.includeApplied),
      check('hidden','Show hidden jobs',view.showHidden)),
    setup&&check('catalog','Add recommended company boards and the Hacker News startup list',true)
  ],async values=>{
    if(values.catalog) await rpc('sources:add',{entries:(await rpc('sources:catalog')).filter(row=>!row.optional)});
    await rpc('settings:update',{config:{...(setup?{onboarded:true}:{}),preferences:readPreferences(values)}});
    Object.assign(view,{includeUndated:!!values.undated,includeApplied:!!values.applied,showHidden:!!values.hidden,limit:70});
    redrawResults();
    toast('Preferences saved.');
  },setup?'Start discovery':'Save preferences');
}
function preferenceSummary(p) {
  const parts=[p.titles.slice(0,3).join(', '),distinctValues(p.countries).join(', '),normalizeLevels(p.seniority).join(', '),
    {24:'Past 24 hours',72:'Past 3 days',168:'Past week',720:'Past month'}[p.freshnessHours]].filter(Boolean);
  return parts.length?parts.join(' · '):'All roles';
}
function discover(data) {
  const {config,sources,runtime}=data;
  const errorSources=sources.filter(source=>source.enabled&&(source.error||source.lastCompleteAt&&Date.now()-Date.parse(source.lastCompleteAt)>source.interval*120000));
  const searchHealth=runtime.find(row=>row.id==='health:search');
  return el('div',{},
    pageHead('Discover',config.onboarded?preferenceSummary(config.preferences):null,[
      config.onboarded&&button('Preferences',()=>discoveryPreferences()),
      menu('More actions',[button('Manage sources',()=>sourceDialog(data)),
        button('Refresh',()=>runDialog('Refresh sources','sources:refresh',{},r=>r.checked+' sources checked.'+(r.errors.length?' '+r.errors.length+' need attention.':''))),
        button('Search with Claude',()=>runDialog('Claude web search','search:now',{},r=>r?.result?.count==null?'Search finished.':r.result.count+' verified jobs · '+(r.result.boards??0)+' boards suggested.'))])
    ]),
    !config.onboarded&&el('div',{class:'notice flex between',style:'margin-bottom:16px'},paragraph('Choose your target roles and sources. You can change them anytime.'),
      el('div',{class:'actions'},button('Skip setup',task(()=>rpc('settings:update',{config:{onboarded:true}})),'quiet'),button('Set up discovery',()=>discoveryPreferences(true),'primary'))),
    el('div',{class:'toolbar'},
      smallSearch('discover-query',view.query,'Search roles or companies',value=>{view.query=value;view.limit=70;redrawResults();}),
      select('discoverSort',[['recent','Most recent'],['match','Best match']],view.sort,{'aria-label':'Sort by'})),
    errorSources.length>0&&el('div',{class:'actions',style:'margin-bottom:10px'},button(errorSources.length+' source'+(errorSources.length===1?' needs':'s need')+' attention',()=>sourceDialog(data),'danger small')),
    searchHealth?.error&&paragraph('Claude search: '+searchHealth.error,'meta'),
    suggestedBoards(runtime.filter(row=>row.kind==='suggestion'&&!sources.some(source=>source.id===row.source?.id))),
    el('div',{id:'view-results'},discoverResults(data)));
}
function suggestedBoards(rows) {
  if(!rows.length) return null;
  rows=rows.sort((a,b)=>(b.count??0)-(a.count??0));
  const addAll=task(async()=>{
    await permit([...new Set(rows.map(row=>origin(row.source.endpoint)))]);
    const count=await rpc('sources:add',{entries:rows.map(row=>row.source)});
    await db.runtime.bulkDelete(rows.map(row=>row.id));toast(count+' boards added.');
  });
  return el('section',{class:'group',style:'margin-bottom:14px'},el('div',{class:'flex between'},el('h2',{},'Suggested boards'),button('Add all '+rows.length,addAll,'small')),
    el('ul',{class:'inset'},rows.slice(0,8).map(row=>el('li',{},
    el('div',{class:'stack compact'},el('strong',{},row.source.name),el('small',{},row.source.provider+(row.count?' · '+row.count+' matching roles':row.title?' · hiring '+row.title:''))),
    el('div',{class:'actions'},button('Add',task(async()=>{
      await permit([origin(row.source.endpoint)]);
      await rpc('sources:add',{entries:[row.source]});await db.runtime.delete(row.id);toast(row.source.name+' added.');
    }),'primary small',{'aria-label':'Add '+row.source.name}),button('Dismiss',task(async()=>{
      await db.runtime.put({id:'dismissed:'+row.source.id,kind:'dismissed',expiresAt:Date.now()+60*86_400_000});await db.runtime.delete(row.id);
    }),'quiet small'))))));
}
root.addEventListener('change',event=>{
  const target=event.target;
  const keys={discoverSort:'sort',trackerStage:'stage',resolved:'includeResolved'};
  const viewKey=keys[target.name];
  if(!viewKey||target.closest('dialog')||selected()==='Settings') return;
  view[viewKey]=target.type==='checkbox'?target.checked:target.value;
  view.limit=70;redrawResults();
});
function filteredJobs(data) {
  const {config,jobs,apps}=data;
  const query=normalized(view.query);
  const tracked=new Set(apps.map(app=>app.jobId));
  const targeted=selected()==='Discover'?detail():'';
  return jobs.filter(job=>{
    if(job.id===targeted) return true;
    if(!job.active&&!job.lead||job.hidden&&!view.showHidden||tracked.has(job.id)&&!view.includeApplied) return false;
    if(!preferenceDecision(job,config.preferences).eligible) return false;
    if(query&&!normalized([job.title,job.company,job.location].join(' ')).includes(query)) return false;
    const age=freshness(job,config.preferences.freshnessHours);
    return age==='verified'||age==='detected'||view.includeUndated&&age==='unknown';
  }).sort((a,b)=>{
    if(a.id===targeted) return -1;if(b.id===targeted) return 1;
    if(view.sort==='match') {
      const difference=(b.match?.score??-1)-(a.match?.score??-1);
      if(difference) return difference;
    }
    return (b.postedAt||b.firstSeenAt||'').localeCompare(a.postedAt||a.firstSeenAt||'') || a.title.localeCompare(b.title);
  });
}
function discoverResults(data) {
  const jobs=filteredJobs(data);
  const tracked=new Map(data.apps.map(app=>[app.jobId,app]));
  const active=data.sources.filter(source=>source.enabled).length;
  const subset=jobs.slice(0,view.limit);
  const hasListings=active>0||data.jobs.length>0;
  return [
    el('div',{class:'results-bar'},el('strong',{},jobs.length.toLocaleString()+' '+(jobs.length===1?'job':'jobs')),el('span',{},active+' '+(active===1?'source':'sources'))),
    jobs.length?el('ul',{class:'result-list','aria-label':'Discovered jobs'},subset.map(job=>jobRow(job,data.config,tracked.get(job.id)))) :
      blank(hasListings?'No new matching jobs':'Connect a job source',hasListings?'New postings appear here as sources update.':'Choose company boards or a feed.',
        !hasListings&&button('Browse sources',()=>sourceDialog(data),'primary')),
    jobs.length>subset.length&&el('div',{class:'actions',style:'margin-top:12px'},button('Show more',()=>{view.limit+=70;redrawResults();}))
  ].filter(Boolean);
}
function whyShown(job,config) {
  const decision=preferenceDecision(job,config.preferences);
  return [decision.matched&&'Matches “'+decision.matched+'”',decision.unknown.length&&'Unknown: '+decision.unknown.join(', ').toLowerCase()].filter(Boolean).join(' · ');
}
function jobRow(job,config,tracked) {
  const age=freshness(job,config.preferences.freshnessHours);
  const salary=job.salary;
  const when=job.postedAt||job.firstSeenAt;
  const why=whyShown(job,config);
  return el('li',{class:'job-row','data-highlight':String(detail()===job.id)},
    el('div',{},
      el('div',{class:'inline-group'},el('button',{type:'button',class:'job-title',onclick:()=>jobDetails(job,config)},job.title),
        age==='verified'&&badge('New','ok'),tracked&&badge(tracked.status,stageStyle(tracked.status)),job.match&&badge(job.match.score+' match','ok'),
        job.sponsorship?.status&&job.sponsorship.status!=='Unknown'&&badge('Sponsorship '+job.sponsorship.status.toLowerCase(),job.sponsorship.status==='Not Supported'?'muted':'ok'),
        job.identityReview&&badge('Identity needs review','warn'),job.hidden&&badge('Hidden')),
      el('p',{class:'meta'},[job.company,job.location,job.seniority,job.workMode,salary?.max?(salary.currency||'')+' '+salary.max.toLocaleString()+(salary.period?'/'+salary.period:''):null,
        relative(when)].filter(Boolean).join(' · ')),
      why&&el('p',{class:'why'},why)),
    el('div',{class:'row-end'},
      button(job.hidden?'Unhide':'Hide',task(()=>db.jobs.update(job.id,{hidden:!job.hidden})),'quiet small',{'aria-label':(job.hidden?'Unhide ':'Hide ')+job.title}),
      tracked?button('View',()=>showApplication(tracked),'small'):button('Save',task(async()=>{
        const result=await saveApplication(null,{jobId:job.id});toast(result.duplicate?'Already in Tracker.':'Saved to Tracker.');
      }),'small',{'aria-label':'Save '+job.title}),
      link('Apply',job.url,'button primary small')));
}
function jobDetails(job,config) {
  const sponsor=job.sponsorship;
  openInspector(job.title,[
    paragraph([job.company,job.location,job.seniority].filter(Boolean).join(' · ')),
    el('div',{class:'actions'},link(job.official?'Apply':'Open',job.url,'button primary'),
      job.jd&&button('Evaluate with Claude',task(async()=>{await rpc('job:evaluate',{id:job.id});jobDetails(await db.jobs.get(job.id),config);}),'')),
    el('dl',{class:'detail-list'},
      job.postedAt&&el('dt',{},'Posted'),job.postedAt&&el('dd',{},dateLabel(job.postedAt)),
      el('dt',{},'First seen'),el('dd',{},dateLabel(job.firstSeenAt)),
      job.lastAbsentAt&&el('dt',{},'Appeared between'),job.lastAbsentAt&&el('dd',{},dateLabel(job.lastAbsentAt)+' and '+dateLabel(job.firstSeenAt)),
      job.dateEvidence&&el('dt',{},'Date source'),job.dateEvidence&&el('dd',{},job.dateEvidence.kind||'Source',' · ',link('Open',job.dateEvidence.url)),
      job.minYears!=null&&el('dt',{},'Experience'),job.minYears!=null&&el('dd',{},job.minYears+'+ years'),
      sponsor?.status&&el('dt',{},'Sponsorship'),sponsor?.status&&el('dd',{},sponsor.status)),
    paragraph(whyShown(job,config),'why'),
    sponsor?.items?.length>0&&el('ul',{class:'stack compact'},sponsor.items.map(item=>el('li',{},el('small',{},item.scope+' · '+item.text+' '),link('Evidence',item.url)))),
    job.match&&el('div',{class:'stack compact'},el('h3',{},job.match.score+' / 100 match · '+job.match.confidence+' confidence'),
      paragraph('Skills '+job.match.skills+' · Experience '+job.match.experience+' · Level '+job.match.seniority+' · Domain '+job.match.domain,'meta'),
      el('ul',{class:'stack compact'},[...job.match.strengths,...job.match.gaps].map(item=>el('li',{},item)))),
    job.analysisError&&paragraph(job.analysisError,'meta'),
    job.jd&&el('details',{},el('summary',{},'Job description'),paragraph(job.jd.slice(0,12500),'job-description')),
    button('Add sponsorship evidence',()=>evidenceDialog(job),'quiet small')
  ]);
}
function evidenceDialog(job) {
  formDialog('Add sponsorship evidence',[
    field('Evidence type',select('kind',[['policy','Employer or recruiter policy'],['history','US historical evidence']],'policy')),
    field('Assessment',select('status',['Likely','Not Supported'],'Likely')),field('Evidence URL',input('url','',{type:'url',required:true})),
    field('Evidence date',input('date','',{type:'date'})),field('What does it say?',textarea('text','',{required:true,maxlength:700}))
  ],async values=>{await rpc('job:sponsor',{...values,id:job.id});toast('Evidence added.');});
}

function sourceDialog(data) {
  let current=data.sources;
  const rows=el('div',{},sourceRows(current));
  const {dialog}=formDialog('Sources',[
    el('div',{class:'actions'},button('Add companies',()=>{dialog.close();companySources();},'primary'),button('Add or test URL',()=>{dialog.close();urlSource();}),
      button('Browse catalog',()=>{dialog.close();catalogDialog();}),
      menu('Import and export',[button('Import source pack',()=>{dialog.close();sourceImport();}),
        button('Export CSV',()=>download('meshjob-sources.csv',sourcesCSV(current))),
        button('Export source pack',()=>download('meshjob-sources.json',JSON.stringify({format:'MeshJob sources',version:1,sources:sourcePack(current)},null,2),'application/json'))])),rows
  ]);
  const live=liveQuery(()=>db.sources.toArray()).subscribe(next=>{current=next;rows.replaceChildren(sourceRows(next));});
  dialog.addEventListener('close',()=>live.unsubscribe(),{once:true});
}
function sourceRows(sources) {
  if(!sources.length) return paragraph('No sources yet.','empty-line');
  return el('ul',{class:'inset'},sources.sort((a,b)=>a.name.localeCompare(b.name)).map(row=>{
    const state=row.enabled?(row.error?'Error':row.inProgressAt?'Checking':row.lastCompleteAt?'On':'Waiting'):'Off';
    const edit=()=>formDialog(row.name,[
      field('Check interval in minutes',input('interval',row.interval,{type:'number',min:10,max:1440,required:true})),
      check('enabled','Enable this source',row.enabled),
      el('p',{class:'meta'},link('Open careers page',row.url))
    ],async (values)=>{
      if(values.enabled&&!row.enabled) await permit([origin(row.endpoint)]);
      await rpc('sources:edit',{id:row.id,enabled:!!values.enabled,interval:values.interval});toast('Source updated.');
    });
    return el('li',{},el('div',{class:'stack compact'},el('div',{class:'inline-group'},el('strong',{},row.name),badge(state,state==='Error'?'hot':state==='On'?'ok':'muted')),
      el('small',{},[row.provider,row.lastCompleteAt&&'checked '+relative(row.lastCompleteAt)].filter(Boolean).join(' · ')),
      row.error&&el('small',{class:'form-error'},row.error)),
      el('div',{class:'actions'},button('Settings',edit,'small'),row.enabled&&button('Check now',()=>runDialog('Check '+row.name,'sources:refresh',{id:row.id,full:true},result=>result.errors[0]?.error||(result.checked?'Check completed.':'Check already in progress.')),'small'),
        button('Remove',()=>formDialog('Remove source',[paragraph('The source stops checking. Tracked applications remain.')],async()=>{await rpc('sources:edit',{id:row.id,remove:true});toast('Source removed.');},'Remove source'),'danger small')));
  }));
}
// Type company names; MeshJob finds their public Ashby, Greenhouse, Lever, SmartRecruiters or Workable boards.
function companySources() {
  const names=textarea('names','',{rows:8,placeholder:'Rillet\nAnthropic\nFigma'});
  const results=el('div',{class:'stack'});
  const {dialog}=formDialog('Add companies',[
    field('Company names, one per line',names),results
  ],async ()=>{
    const list=names.value.split(/\n|,/).map(value=>value.trim()).filter(Boolean);
    if(!list.length) throw new Error('Enter at least one company name.');
    await permit(BOARD_API_ORIGINS);
    results.replaceChildren(paragraph('Looking up '+list.length+' companies…'));
    const rows=await rpc('sources:resolve',{names:list,op:uid()});
    const found=rows.filter(row=>row.source&&!row.source.existing);
    results.replaceChildren(el('ul',{class:'inset'},rows.map(row=>el('li',{},el('span',{},row.name),
      el('small',{},row.source?row.source.existing?'Already added':row.source.provider+' · '+row.source.count+' jobs':'No public board found · add its careers URL')))),
      found.length>0&&button('Add '+found.length+' boards',task(async()=>{
        const count=await rpc('sources:add',{entries:found.map(row=>row.source)});dialog.close();toast(count+' boards added.');
      }),'primary'));
    return false;
  },'Find boards');
}
function urlSource() {
  const url=input('url','',{type:'url',required:true,placeholder:'https://…'});
  const provider=select('provider',[['','Detect automatically'],['rss','RSS or Atom'],['careers','Careers page']],'');
  const allowed=check('permitted','I verified that this Workday site permits automated listing checks.');
  const preview=el('div',{class:'stack','aria-live':'polite'});
  const {dialog}=formDialog('Add or test a source',[
    field('Public careers, board, feed, or GitHub URL',url),field('Adapter',provider),allowed,preview
  ],async ({url,provider,permitted})=>{
    const data=detectSource(url,provider);
    await permit([origin(data.endpoint)]);
    preview.replaceChildren(paragraph('Checking the source…'));
    try {
      const result=await rpc('sources:test',{source:{url,provider,permitted:!!permitted},op:uid()});
      preview.replaceChildren(el('div',{class:'notice'},el('strong',{},result.source.name),paragraph(result.source.provider+' · '+result.count+' listings returned.')),
        result.examples.map(row=>paragraph(row.title+(row.location?' · '+row.location:''),'meta')),
        button('Activate source',task(async()=>{const count=await rpc('sources:add',{entries:[{...result.source,permitted:!!permitted}]});dialog.close();toast(count?'Source connected.':'This source is already configured.');}),'primary'));
    }catch(error){preview.replaceChildren();throw error;}
    return false;
  },'Test connection');
}
async function catalogDialog() {
  const catalog=await rpc('sources:catalog');
  const known=new Set((await db.sources.toArray()).map(s=>s.id));
  const chosen=el('div',{class:'form-grid'},catalog.map((source,i)=>el('div',{},check('board-'+i,source.name,false),el('small',{},source.method))));
  formDialog('Recommended job sources',[
    button('Select all company boards',()=>{for(const [i,source] of catalog.entries())if(!source.optional&&!known.has(source.id))chosen.querySelector('[name=board-'+i+']').checked=true;},'small'),
    chosen
  ],async values=>{
    const rows=catalog.filter((source,i)=>values['board-'+i]&&!known.has(source.id));
    if(!rows.length) throw new Error('Select at least one new source.');
    await permit(rows.map(row=>origin(row.endpoint)));
    const count=await rpc('sources:add',{entries:rows});toast(count+' sources connected.');
  },'Connect sources');
}
function sourceImport() {
  const paste=textarea('paste','',{placeholder:'One public URL per line'});
  const file=input('pack','',{type:'file',accept:'.json,.csv,text/csv,application/json'});
  const previews=el('div',{class:'stack'});
  const {dialog}=formDialog('Import sources',[
    field('Paste URLs or a source pack',paste),field('Or choose a JSON or CSV source pack',file),previews
  ],async ()=>{
    const text=file.files[0]?await file.files[0].text():paste.value;
    const rows=readSources(text,{unescape:true});
    const usable=rows.filter(row=>row.provider!=='workday');
    if(!usable.length) throw new Error('No supported sources found. Connect Workday sites individually after confirming site permission.');
    previews.replaceChildren(paragraph(usable.length+' sources ready. '+(rows.length-usable.length)+' Workday sources need individual review.'),
      usable.slice(0,12).map(row=>paragraph(row.name+' · '+row.provider,'meta')),
      button('Grant access and import',task(async()=>{
        await permit(usable.map(row=>origin(row.endpoint)));
        const count=await rpc('sources:add',{entries:usable});dialog.close();toast(count+' new sources imported.');
      }),'primary'));
    return false;
  },'Preview sources');
}

function tracker(data) {
  return el('div',{},
    pageHead('Tracker',null,[
      menu('More actions',[button('Add email',addMailDialog),button('Import CSV',()=>applicationImport()),button('Export',()=>exportDialog(data))]),
      button('Add application',()=>applicationEditor(),'primary')
    ]),
    el('div',{class:'toolbar'},el('div',{class:'segmented','aria-label':'Tracker view'},[['table','Table'],['status','Status']].map(([key,label])=>button(label,event=>{
      view.trackerMode=key;view.limit=70;
      for(const control of event.currentTarget.parentElement.children)control.setAttribute('aria-pressed',String(control===event.currentTarget));
      redrawResults();
    },'',{'aria-pressed':String(view.trackerMode===key)}))),
      smallSearch('tracker-query',view.trackQuery,'Search applications',value=>{view.trackQuery=value;view.limit=70;redrawResults();}),
      select('trackerStage',[['','All statuses'],...STAGES],view.stage,{'aria-label':'Filter by status'})),
    el('div',{id:'view-results',class:'stack large'},trackerResults(data))
  );
}
const matchingApps=apps=>apps.filter(app=>(!view.stage||view.stage===app.status)&&
  (!view.trackQuery||normalized([app.company,app.title,app.requisition,app.location,app.notes,app.source,app.seniority].join(' ')).includes(normalized(view.trackQuery))))
  .sort((a,b)=>(b.appliedAt||b.updatedAt).localeCompare(a.appliedAt||a.updatedAt));
const dateOnly=new Intl.DateTimeFormat(undefined,{dateStyle:'medium'});
const shortDate=timestamp=>timestamp?dateOnly.format(new Date(timestamp)):'—';
const openApplication=(app,label=app.title)=>button(label,()=>showApplication(app),'quiet application-link',{'aria-label':label===app.title?app.title:'Open '+app.company});
const applicationStatus=app=>el('div',{class:'inline-group'},badge(app.status,stageStyle(app.status)),
  app.submission==='needs_check'&&badge('Needs check','warn'),app.review&&badge('Conflict','warn'));
function applicationTable(apps,total) {
  return dataTable(['Company','Job title','Level','Status','Applied','Resume','Source'],
    apps.map(app=>[
      openApplication(app,app.company),
      el('div',{class:'inline-group'},openApplication(app),button('Edit',task(async()=>{
        const job=app.jobDescription===undefined?await db.jobs.get(app.jobId):null;
        applicationEditor(app,app.jobDescription??job?.jd??'');
      }),'quiet small',{'aria-label':'Edit '+app.title})),
      app.seniority||'—',applicationStatus(app),shortDate(app.appliedAt),
      versionLabel(app.materials?.resume)||'—',app.source||'—'
    ]),total.toLocaleString()+' applications','tracker-table');
}
function statusBoard(apps) {
  return el('div',{class:'status-board'},STAGES.map(status=>{
    const group=apps.filter(app=>app.status===status);
    return group.length>0&&el('section',{class:'status-group'},
      el('h3',{},status,' ',el('small',{},group.length)),
      el('ul',{class:'clean-list'},group.map(app=>el('li',{},openApplication(app),
        el('small',{class:'block'},app.company+(app.appliedAt?' · '+shortDate(app.appliedAt):'')))))
    );
  }));
}
function trackerResults(data) {
  const reversed=new Set(data.events.filter(event=>event.kind==='undo').map(event=>event.reverses));
  const pending=data.events.filter(event=>event.urgent&&!reversed.has(event.id)&&(view.includeResolved||!event.resolvedAt));
  const unlinked=data.events.filter(event=>!event.urgent&&event.review&&!event.applicationId&&!reversed.has(event.id));
  const apps=matchingApps(data.apps);
  const appNames=new Map(data.apps.map(app=>[app.id,app.company+' · '+app.title]));
  const openActions=pending.filter(event=>!event.resolvedAt).length;
  const contents=apps.length?(view.trackerMode==='status'?statusBoard(apps.slice(0,view.limit)):applicationTable(apps.slice(0,view.limit),apps.length)):
    blank('No applications here',view.trackQuery||view.stage?'Adjust the search or status filter.':'Applications you save or fill appear here.',button('Add application',()=>applicationEditor(),'primary'));
  return [
    (pending.length>0||detail()==='actions')&&el('section',{class:'group',id:'action-queue'},
      el('div',{class:'flex between'},el('h2',{},'Needs attention ',openActions>0&&badge(String(openActions),'hot')),check('resolved','Show resolved',view.includeResolved)),
      pending.length?el('ul',{class:'inset actions-list'},pending.sort((a,b)=>b.at.localeCompare(a.at)).map(event=>actionRow(event,appNames))):paragraph('No open actions.','empty-line')),
    unlinked.length>0&&el('section',{class:'group'},el('h2',{},'Email review'),el('ul',{class:'inset actions-list'},unlinked.slice(0,30).map(event=>actionRow(event,appNames)))),
    contents,
    apps.length>view.limit&&button('Show more applications',()=>{view.limit+=70;redrawResults();})
  ].filter(Boolean);
}
function actionRow(event,appNames) {
  const status=event.resolvedAt?'Resolved':event.acknowledgedAt?'Acknowledged':'Open';
  return el('li',{class:'action-row'+(event.acknowledgedAt?' acknowledged':'')},
    el('div',{class:'flex between'},el('strong',{},event.subject||event.category||'Recruiting message'),event.urgent&&badge(status,status==='Open'?'hot':'muted')),
    paragraph((appNames.get(event.applicationId)||'Not linked')+' · '+dateLabel(event.at)+(event.deadline?' · Due '+event.deadline.text:''),'meta'),
    event.excerpt&&paragraph(event.excerpt,'meta'),
    el('div',{class:'actions'},link('Open email',event.url,'button small'),!event.resolvedAt&&event.urgent&&!event.acknowledgedAt&&button('Acknowledge',task(()=>rpc('action:status',{id:event.id,operation:'ack'})),'small'),
      event.urgent&&button(event.resolvedAt?'Reopen':'Resolve',task(()=>rpc('action:status',{id:event.id,operation:event.resolvedAt?'reopen':'resolve'})),'small'),
      event.review&&button('Link to application',()=>emailReview(event),'small'),
      !event.urgent&&button('Undo sync',task(()=>undoEvent(event.id)),'quiet small')));
}
async function emailReview(event) {
  const apps=await db.applications.toArray();
  formDialog('Link email to an application',[
    paragraph(event.subject),paragraph(event.excerpt,'meta'),link('Open email',event.url),
    field('Application',select('application',[['','Choose an application'],...apps.map(app=>[app.id,app.company+' · '+app.title])],event.applicationId??'')),
    field('Stage change · optional',select('stage',[['','Keep current stage'],...STAGES],''))
  ],async values=>{
    if(!values.application)throw new Error('Choose an application.');
    const {appendEvent}=await import('./tracker.js');
    const result=await appendEvent({id:'review-mail:'+event.id,applicationId:values.application,kind:'reviewed-email',at:event.at,url:event.url,subject:event.subject});
    if(!result.duplicate&&values.stage)await changeStage(values.application,values.stage,event.at,'Reviewed email');
    await db.events.update(event.id,{review:false,applicationId:values.application,pendingRead:false});
    toast('Email linked.');
  },'Link email');
}
function pickOptional(name,label,options,current) {
  const values=current&&!options.includes(current)?[...options,current]:options;
  return field(label,select(name,[['','Not set'],...values],current??''));
}
function confirmDeleteApplication(app) {
  formDialog('Delete application',[paragraph(app.company+' · '+app.title),paragraph('Delete this application and its history? The job and documents stay.')],async()=>{
    await deleteApplication(app.id);closeInspector();toast('Application deleted.');
  },'Delete application');
}
function applicationEditor(app,description='') {
  const applied=app?.appliedAt?new Date(app.appliedAt):null;
  const originalDate=applied?new Date(applied.getTime()-applied.getTimezoneOffset()*60_000).toISOString().slice(0,16):'';
  const formFields={};
  for(const [name,value] of Object.entries({company:app?.company,title:app?.title,url:app?.url,requisition:app?.requisition,location:app?.location,source:app?.source})) {
    formFields[name]=input(name,value,{required:['company','title'].includes(name),type:name==='url'?'url':'text',...(name==='source'?{list:'tracker-sources'}:{})});
  }
  const {dialog}=formDialog(app?'Edit application':'Add application',[
    el('div',{class:'form-grid'},field('Company',formFields.company),field('Job title',formFields.title),field('Job URL',formFields.url),field('Requisition ID',formFields.requisition),
      field('Location',formFields.location),field('Source',formFields.source),el('datalist',{id:'tracker-sources'},SOURCE_CHOICES.map(value=>el('option',{value}))),
      pickOptional('seniority','Level',LEVELS,app?.seniority),
      pickOptional('workMode','Workplace type',WORKPLACE_TYPES,app?.workMode),
      pickOptional('priority','Priority',PRIORITIES,app?.priority)),
    button('Read public job URL',task(async()=>{
      const url=formFields.url.value;const parsed=httpUrl(url);
      if(!parsed||parsed.protocol!=='https:')throw new Error('Enter an HTTPS job URL.');
      await permit([origin(url)]);
      const details=await rpc('job:url-preview',{url});
      for(const [key,value] of Object.entries(details)) if(value && formFields[key]&&!formFields[key].value) formFields[key].value=value;
      toast('Job details loaded.');
    }),'small'),
    el('div',{class:'form-grid'},field('Current stage',select('stage',STAGES,app?.status??'Saved')),
      field('Actual submission date · optional',input('date',originalDate,{type:'datetime-local'}))),
    field('Notes',textarea('notes',app?.notes??'')),
    el('details',{},el('summary',{},'Job description'),
      field('Job description · optional',textarea('jobDescription',description,{rows:7,maxlength:JOB_DESCRIPTION_LIMIT,placeholder:'Paste the job description here'}))),
    app&&el('div',{class:'actions'},button('Delete application',()=>{dialog.close();confirmDeleteApplication(app);},'danger'))
  ],async values=>{
    if(!app&&!values.jobDescription.trim()) delete values.jobDescription;
    const tracking=app?{stage:values.stage,submissionDate:values.date===originalDate?undefined:values.date?new Date(values.date).toISOString():null}:undefined;
    const result=await saveApplication(values,{existingId:app?.id,tracking});
    if(result.duplicate&&!app){toast('This requisition is already tracked.');dialog.close();showApplication(result.application);return false;}
    if(!app&&values.date) {
      const appliedAt=new Date(values.date).toISOString();
      await changeStage(result.application.id,'Applied',appliedAt);
      if(!['Saved','Preparing','Applied'].includes(values.stage)) await changeStage(result.application.id,values.stage);
    } else if(!app&&values.stage&&values.stage!=='Saved') await changeStage(result.application.id,values.stage);
    toast(result.similar?'Saved separately. A similar role already exists.':app?'Application updated.':'Application added.');
  });
}
async function openMaterial(ref) {
  const material=await materialFor(ref);
  if(!material?.blob) {toast('That file is no longer stored. Its name is kept in history.',true);return;}
  const url=URL.createObjectURL(material.blob);
  window.open(url,'_blank','noopener,noreferrer');
  setTimeout(()=>URL.revokeObjectURL(url),120_000);
}
async function showApplication(app) {
  const [events,job]=await Promise.all([db.events.where('applicationId').equals(app.id).toArray(),app.jobDescription===undefined?db.jobs.get(app.jobId):null]);
  events.sort((a,b)=>b.at.localeCompare(a.at));
  const description=app.jobDescription??job?.jd??'';
  const history=events.filter(event=>event.kind!=='undo');
  const reversals=new Set(events.filter(e=>e.kind==='undo').map(e=>e.reverses));
  const material=ref=>ref?(ref.external?versionLabel(ref):el('span',{},versionLabel(ref),' ',button('Open',task(()=>openMaterial(ref)),'quiet small'))):'Unknown';
  openInspector(app.title,[
    el('div',{class:'flex between'},el('strong',{},app.company),applicationStatus(app)),
    el('div',{class:'actions'},button('Update stage',()=>stageDialog(app),'primary small'),button('Edit details',()=>applicationEditor(app,description),'small'),link('Open job',app.url,'button small')),
    el('dl',{class:'detail-list'},
      el('dt',{},'Level'),el('dd',{},app.seniority||'—'),el('dt',{},'Source'),el('dd',{},app.source||'—'),
      el('dt',{},'Resume'),el('dd',{},material(app.materials?.resume)),
      app.materials?.cover&&el('dt',{},'Cover letter'),app.materials?.cover&&el('dd',{},material(app.materials.cover)),
      el('dt',{},'Submitted'),el('dd',{},app.appliedAt?dateLabel(app.appliedAt):app.submission==='needs_check'?'Needs check':'Not yet'),
      app.requisition&&el('dt',{},'Requisition'),app.requisition&&el('dd',{},app.requisition),
      app.location&&el('dt',{},'Location'),app.location&&el('dd',{},app.location)),
    app.notes&&paragraph(app.notes),
    app.review&&paragraph('Conflicting stages need your review.','form-error'),
    description&&el('details',{},el('summary',{},'Job description'),paragraph(description,'job-description')),
    el('h3',{},'History'),history.length?el('ul',{class:'inset'},history.map(e=>el('li',{},
      el('div',{class:'stack compact'},el('span',{},(e.stage||e.category||e.kind)+(reversals.has(e.id)?' · Undone':'')),el('small',{},dateLabel(e.at)),e.note&&el('small',{},e.note)),
      el('div',{class:'actions'},e.url&&link('Open',e.url),!reversals.has(e.id)&&e.kind!=='stage'&&button('Undo',task(async()=>{
        await undoEvent(e.id);showApplication(await db.applications.get(app.id));
      }),'quiet small'))))):paragraph('No recorded events.','empty-line')
  ]);
}
function stageDialog(app) {
  formDialog('Update stage',[
    field('Stage',select('stage',STAGES,app.status)),field('Effective date · optional',input('date','',{type:'datetime-local'})),
    field('Note · optional',textarea('note',''))
  ],async ({stage,date,note})=>{
    await changeStage(app.id,stage,date?new Date(date).toISOString():undefined,note);
    toast('Stage updated.');showApplication(await db.applications.get(app.id));
  });
}
function applicationImport() {
  const file=input('file','',{type:'file',accept:'.csv,text/csv',required:true});
  const unescape=check('meshjob','Decode escaped cells from a MeshJob export');
  const result=el('div',{class:'stack'});
  let parsed;
  const {dialog}=formDialog('Import applications from CSV',[field('CSV file',file),unescape,result],async (_,form)=>{
    if(!file.files[0]||file.files[0].size>24_000_000)throw new Error('Choose a CSV file smaller than 24 MB.');
    const text=await file.files[0].text();
    parsed=csvPreview(text,{unescape:form.elements.meshjob.checked});
    const grid=el('div',{class:'form-grid'},Object.entries(parsed.mapping).map(([key,value])=>field(key,select('map-'+key,[['','Ignore'],...parsed.head],value))));
    const summary=el('div',{class:'stack'});
    const preview=()=>{
      const mapped=Object.fromEntries(Object.keys(parsed.mapping).map(key=>[key,grid.querySelector('[name="map-'+key+'"]').value]));
      parsed=csvPreview(text,{mapping:mapped,unescape:form.elements.meshjob.checked});
      summary.replaceChildren(paragraph(parsed.entries.length+' valid · '+parsed.errors.length+' rejected'),
        parsed.entries.length>0&&dataTable(['Company','Title','Stage'],parsed.entries.slice(0,6).map(row=>[row.company,row.title,row.stage]))||el('span',{}),
        ...parsed.errors.slice(0,10).map(row=>paragraph('Row '+row.row+' · '+row.error,'form-error')));
    };
    grid.addEventListener('change',preview);preview();
    result.replaceChildren(el('h3',{},'Column mapping'),grid,summary,button('Import valid records',task(async()=>{
      if(!parsed.entries.length)throw new Error('No valid records to import.');
      const status=await importApplicationCSV(parsed);
      dialog.close();toast(status.added+' added · '+status.duplicates+' duplicates skipped · '+status.errors.length+' rejected');
    }),'primary'));
    return false;
  },'Preview CSV');
}
function exportDialog(data) {
  formDialog('Export MeshJob data',[
    paragraph('Exports contain personal data. Save them to a device you control.'),
    el('div',{class:'actions'},
      button('All applications CSV',()=>download('meshjob-applications.csv',applicationCSV(data.apps))),
      button('Current filtered CSV',()=>download('meshjob-filtered.csv',applicationCSV(matchingApps(data.apps)))),
      button('Event history CSV',()=>download('meshjob-events.csv',eventsCSV(data.events))),
      button('Matched jobs CSV',task(async()=>download('meshjob-jobs.csv',jobsCSV(await db.jobs.filter(job=>!!job.match).toArray())))),
      button('Source list CSV',task(async()=>download('meshjob-sources.csv',sourcesCSV(await db.sources.toArray())))),
      button('Full backup ZIP',task(backup),'primary'))
  ]);
}
function breakdown(title,applications,events,key) {
  const groups=new Map();
  for(const app of applications.filter(row=>row.appliedAt)) {
    const name=key(app)||'Unknown';
    groups.set(name,[...(groups.get(name)??[]),app]);
  }
  if(!groups.size) return null;
  const rows=[...groups].sort((a,b)=>b[1].length-a[1].length).slice(0,12).map(([name,apps])=>{
    const {overall}=analyze({applications:apps,events});
    return [name,overall.applications,overall.interviews,overall.offers];
  });
  return section(title,dataTable([title.replace(/^By /,''),'Applications','Interviews','Offers'],rows));
}
function stats({applications,events}) {
  const range=statsPeriod(view.statsRange);
  const inRange=applications.filter(app=>!app.appliedAt||range.start==null||Date.parse(app.appliedAt)>=range.start&&Date.parse(app.appliedAt)<=range.end);
  const {overall}=analyze({applications,events,range});
  const metric=(label,value)=>el('div',{class:'metric'},el('strong',{},value.toLocaleString()),el('span',{},label));
  const percentage=value=>overall.applications?new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:1}).format(value/overall.applications):'—';
  return el('div',{class:'stack large'},
    pageHead('Stats',range.label,el('div',{class:'segmented','aria-label':'Stats period'},
      [['week','Week'],['month','Month'],['year','Year'],['all','All']].map(([key,label])=>button(label,()=>{
        view.statsRange=key;render(routeData,true);
        main.querySelector('.segmented [aria-pressed=true]')?.focus();
      },'',{'aria-pressed':String(view.statsRange===key)})))),
    el('div',{class:'metrics'},metric('Applications',overall.applications),metric('Interviews',overall.interviews),metric('Offers',overall.offers),metric('Accepted',overall.accepted)),
    section('Outcomes',overall.applications?
      dataTable(['Stage reached','Applications','Share'],[['Assessment',overall.OA],['Interview',overall.interviews],['Offer',overall.offers],
        ['Rejected',overall.rejected],['Withdrawn',overall.withdrawn],['Accepted',overall.accepted]].map(([name,count])=>[name,count,percentage(count)])):
      paragraph('No submitted applications in this period.','empty-line')),
    breakdown('By level',inRange,events,app=>app.seniority),
    breakdown('By resume',inRange,events,app=>versionLabel(app.materials?.resume)),
    breakdown('By source',inRange,events,app=>app.source)
  );
}
