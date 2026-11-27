import { liveQuery } from 'dexie';
import { db, settings } from './db.js';
import { distinctValues, freshness, httpUrl, JOB_DESCRIPTION_LIMIT, normalized, preferenceDecision, STAGES, uid } from './domain.js';
import { detectSource } from './sources.js';
import { analyze, statsPeriod } from './stats.js';
import { changeStage, deleteApplication, saveApplication, undoEvent } from './tracker.js';
import { applicationCSV, csvPreview, eventsCSV, importApplicationCSV, jobsCSV, makeBackup, readSources, sourcePack, sourcesCSV } from './portability.js';
import { blank,badge,button,check,dataTable,dateLabel,download,el,field,formDialog,input,link,paragraph,permit,readTokens,rpc,section,select,task,textarea,toast,tokenField } from './ui.js';
import { profileView } from './profile.js';
import { COUNTRY_OPTIONS, EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, PRIORITIES, regionOptions, WORKPLACE_TYPES } from './preferences.js';

const root=document.querySelector('#app');
const tabs=['Discover','Tracker','Stats','Profile'];
const view={query:'',sort:'recent',verifiedOnly:false,includeApplied:false,showHidden:false,
  trackQuery:'',stage:'',includeResolved:false,trackerMode:'table',month:new Date(),statsRange:'all',limit:70};
let shell,main,nav,modeButton,subscription,routeData,routeKey;
const selected=()=>tabs.find(title=>title.toLowerCase()===location.hash.slice(1).split('/')[0])??'Discover';
const detail=()=>location.hash.split('/')[1];
const route=(tab,sub='')=>{location.hash='#'+tab.toLowerCase()+(sub?'/'+sub:'');};
const brand=()=>el('a',{class:'brand',href:'#discover'},el('img',{src:'icons/icon32.png',alt:''}),'MeshJob');
const timestamp=value=>el('time',{datetime:value},dateLabel(value));
const stageStyle=stage=>['Applied','OA','Interview','Offer','Accepted'].includes(stage)?'ok':['Rejected','Withdrawn'].includes(stage)?'muted':'warn';
const smallSearch=(id,value,label,fn)=>input(id,value,{id,type:'search',placeholder:label,'aria-label':label,oninput:event=>fn(event.target.value)});
const origin=url=>new URL(url).origin+'/*';
const niceAge={verified:'Verified recent',detected:'Newly detected',unknown:'Date unverified',older:'Older posting'};
const pageHead=(title,subtitle,actions)=>el('header',{class:'page-head'},el('div',{},el('h1',{},title),paragraph(subtitle)),actions&&el('div',{class:'actions'},actions));

function runDialog(label,type,args,message) {
  const id=uid();
  const status=el('p',{role:'status'},'Working…');
  let running=true;
  const cancel=button('Cancel',task(async()=>{await rpc('operation:cancel',{op:id});status.textContent='Cancelling…';}));
  const {dialog}=formDialog(label,[status,cancel]);
  dialog.addEventListener('cancel',event=>{
    if (running) {event.preventDefault();cancel.click();}
  });
  return rpc(type,{...args,op:id}).then(result=>{
    running=false;
    status.textContent=message(result);
    cancel.textContent='Close';
    cancel.replaceWith(button('Close',()=>dialog.close(),'primary'));
    return result;
  },error=>{
    running=false;status.textContent=error.message;
    cancel.replaceWith(button('Close',()=>dialog.close(),'primary'));
  });
}
function redrawResults() {
  if(!routeData) return;
  const container=document.getElementById('view-results');
  if(!container) return;
  container.replaceChildren(...(selected()==='Discover'?discoverResults(routeData):trackerResults(routeData)));
}
function navigation() {
  modeButton=button('Search status',()=>routeData&&searchMode(routeData.config),'mode');
  nav=el('nav',{class:'nav','aria-label':'Main navigation'},tabs.map(title=>el('a',{href:'#'+title.toLowerCase()},title)));
  main=el('main',{id:'main',class:'workspace',tabindex:'-1'},paragraph('Opening your local dashboard…'));
  shell=el('div',{},el('header',{class:'app-header'},el('div',{class:'header-inner'},brand(),nav,modeButton)),main);
  root.replaceChildren(shell);
}
async function pageData(tab) {
  const config=await settings();
  if(tab==='Discover') {
    const [jobs,apps,sources,runtime]=await Promise.all([db.jobs.filter(job=>job.active||job.lead||job.hidden).toArray(),db.applications.toArray(),db.sources.toArray(),db.runtime.where('kind').equals('health').toArray()]);
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
  const [materials,answers,health,usage]=await Promise.all([db.materials.toArray(),db.answers.toArray(),db.runtime.get('health:gmail'),db.usage.toArray()]);
  return {config,materials,answers,health,usage};
}
function updateHeader(config) {
  for(const a of nav.children) {
    if(a.textContent===selected())a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  }
  modeButton.className='button mode '+config.mode.toLowerCase();
  modeButton.replaceChildren(el('span',{class:'status-dot','aria-hidden':'true'}),'Search '+config.mode.toLowerCase(),el('span',{'aria-hidden':'true'},'⌄'));
}
function render(data,force=false) {
  const setupChanged=routeData?.config.onboarded!==data.config.onboarded;
  routeData=data;
  updateHeader(data.config);
  if(!force&&!setupChanged&&main.contains(document.activeElement)&&document.activeElement?.matches('input,textarea,select')) {
    redrawResults();
    return;
  }
  const tab=selected();
  if(!force&&!setupChanged&&!location.hash.startsWith('#profile')&&main.contains(document.activeElement)&&document.activeElement?.matches('button,a')&&document.querySelector('#view-results')) {
    redrawResults();
    return;
  }
  const content=tab==='Discover'?discover(data):tab==='Tracker'?tracker(data):tab==='Stats'?stats(data):profileView(data,{backup,storageHelp});
  main.replaceChildren(content);
  performance.mark('meshjob-render');
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
window.addEventListener('hashchange',()=>{if(location.hash==='#main') return;navigate();});

function searchMode(config) {
  const mode=select('mode',['Active','Paused','Finished'],config.mode);
  const {dialog}=formDialog('Search status',[
    field('Mode',mode),paragraph('Pause stops scheduled discovery, AI analysis, Gmail sync, and alerts. Your tracker and local exports remain available.')
  ],async ({mode})=>{
    if(mode==='Finished'&&config.mode!=='Finished') {dialog.close();await finishSearch();return false;}
    await rpc('mode:set',{mode});toast('Search is '+mode.toLowerCase()+'.');
  },'Update');
}
async function finishSearch() {
  const apps=await db.applications.toArray();
  formDialog('Finish your job search',[
    paragraph('Stop scheduled checks and notifications. Already-sent requests may finish or be billed. You can continue to use your data offline.'),
    field('Accepted application · optional',select('accepted',[['','Choose an application'],...apps.filter(app=>['Offer','Accepted'].includes(app.status)).map(app=>[app.id,app.company+' · '+app.title])],'')),
    button('Download a backup first',task(backup),''),
    check('confirm','I want to stop scheduled services.')
  ],async ({accepted,confirm})=>{
    if(!confirm) throw new Error('Confirm that you want to stop scheduled services.');
    if(accepted) await changeStage(accepted,'Accepted');
    await rpc('mode:set',{mode:'Finished',confirm:true});
    toast('Search finished. Your local data is available.');
  },'Finish search');
}
async function backup() {
  toast('Preparing a backup with your personal data and PDFs…');
  download('meshjob-backup.zip',await makeBackup(),'application/zip');
  toast('Backup prepared.');
}
function storageHelp() {
  formDialog('Local storage',[
    paragraph('Application history, answers, and PDFs stay in this Chrome profile. Credentials are kept separately from exports. Export before uninstalling.'),
    button('Download backup',task(backup),'primary')
  ]);
}

const preferenceLists=['titles','countries','locations','seniority','employmentType','workMode'];

function readPreferences(values) {
  return {
    ...Object.fromEntries(preferenceLists.map(key=>[key,readTokens(values,key)])),
    sponsorship:values.sponsorship||'Unspecified',
    ...(values.freshnessHours ? {freshnessHours:Number(values.freshnessHours)} : {})
  };
}
function preferencesForm(p) {
  const countries=distinctValues(p.countries);
  const regions=tokenField('locations','Regions or cities',p.locations,{
    choices:regionOptions(countries),placeholder:'Add a region, state, or city'
  });
  const country=tokenField('countries','Countries',countries,{
    choices:COUNTRY_OPTIONS,custom:false,change:values=>regions.setChoices(regionOptions(values))
  });
  return el('div',{class:'stack large preference-fields'},
    tokenField('titles','Target job titles',p.titles,{placeholder:'Software engineer, Data analyst'}).root,
    el('div',{class:'form-grid'},country.root,regions.root,
      tokenField('seniority','Experience level',p.seniority,{choices:EXPERIENCE_LEVELS,custom:false}).root,
      tokenField('employmentType','Employment type',p.employmentType,{choices:EMPLOYMENT_TYPES,custom:false}).root,
      tokenField('workMode','Workplace type',p.workMode,{choices:WORKPLACE_TYPES,custom:false}).root,
      field('Visa sponsorship',select('sponsorship',[['Unspecified','No preference'],'Required','Not required'],p.sponsorship)),
      field('Date posted',select('freshnessHours',[
        ['24','Past 24 hours'],['168','Past week'],['720','Past month'],
        ...([24,168,720].includes(p.freshnessHours)?[]:[[String(p.freshnessHours),'Past '+p.freshnessHours+' hours']])
      ],String(p.freshnessHours)),'Includes jobs with unverified posting dates by default.'))
  );
}
function discoveryPreferences(setup=false) {
  const {config}=routeData;
  formDialog(setup?'Set up discovery':'Preferences',[
    preferencesForm(config.preferences),
    el('div',{class:'discovery-options stack'},
      check('verifiedOnly','Only show jobs with a verified posting date',view.verifiedOnly),
      check('applied','Show tracked jobs',view.includeApplied),
      check('hidden','Show hidden jobs',view.showHidden)),
    setup&&check('catalog','Add recommended company job boards'),
    setup&&paragraph('Import public job listings from Greenhouse, Ashby, and Lever.','meta')
  ],async values=>{
    if(values.catalog) {
      await permit(['https://boards-api.greenhouse.io/*','https://api.ashbyhq.com/*','https://api.lever.co/*']);
      const catalog=(await rpc('sources:catalog')).filter(row=>!row.optional);
      await rpc('sources:add',{entries:catalog});
    }
    await rpc('settings:update',{config:{...(setup?{onboarded:true}:{}),preferences:readPreferences(values)}});
    Object.assign(view,{verifiedOnly:!!values.verifiedOnly,includeApplied:!!values.applied,showHidden:!!values.hidden,limit:70});
    redrawResults();
    toast('Preferences saved.');
  },setup?'Start discovery':'Save preferences');
}
function discover(data) {
  const {config,sources,runtime}=data;
  const filtered=el('div',{id:'view-results'},discoverResults(data));
  const errorSources=sources.filter(source=>source.enabled&&(source.error||source.lastCompleteAt&&Date.now()-Date.parse(source.lastCompleteAt)>source.interval*120000));
  const searchHealth=runtime.find(row=>row.id==='health:search');
  const missed=runtime.find(row=>row.id==='health:missed-search');
  const scheduled=searchHealth?.running?'Claude search is running.':searchHealth?.error || (searchHealth?.successAt?'Last Claude search '+dateLabel(searchHealth.successAt):'');
  return el('div',{},
    pageHead('Discover','Find current openings from public sources and review new leads.',[
      button('Manage sources',()=>sourceDialog(data)),
      button('Search with Claude',()=>runDialog('Claude web search','search:now',{},r=>r?.result?.count==null?'Search finished. Review source health for details.':r.result.count+' new leads found.')),
      button('Refresh',()=>runDialog('Refresh sources','sources:refresh',{},r=>r.checked+' sources checked.'+(r.errors.length?' '+r.errors.length+' need attention.':'')),'primary')
    ]),
    !config.onboarded&&el('div',{class:'notice flex between',style:'margin-bottom:18px'},paragraph('Choose your target roles and public sources. You can change them anytime.'),
      el('div',{class:'actions'},button('Skip setup',task(()=>rpc('settings:update',{config:{onboarded:true}})),'quiet'),button('Set up discovery',()=>discoveryPreferences(true),'primary'))),
    el('div',{class:'stack'},
      el('div',{class:'toolbar discovery-toolbar'},
        smallSearch('discover-query',view.query,'Role or company',value=>{view.query=value;view.limit=70;redrawResults();}),
        select('discoverSort',[['recent','Most recent'],['match','Best match']],view.sort,{'aria-label':'Sort by'}),
        config.onboarded&&button('Preferences',()=>discoveryPreferences())),
      errorSources.length>0&&el('div',{},button(errorSources.length+' source'+(errorSources.length===1?'':'s')+' need attention',()=>sourceDialog(data),'danger')),
      scheduled&&paragraph(scheduled,'meta'),missed&&paragraph('Missed Claude slots · '+missed.day+' · '+missed.slots.join(', '),'meta'),
      filtered)
  );
}
root.addEventListener('change',event=>{
  const target=event.target;
  const keys={discoverSort:'sort',trackerStage:'stage',resolved:'includeResolved'};
  const viewKey=keys[target.name];
  if(!viewKey||target.closest('dialog')||selected()==='Profile') return;
  view[viewKey]=target.type==='checkbox'?target.checked:target.value;
  view.limit=70;redrawResults();
});
function filteredJobs(data) {
  const {config,jobs,apps}=data;
  const query=normalized(view.query);
  const tracked=new Set(apps.map(app=>app.jobId));
  const targeted=detail()&&selected()==='Discover'?decodeURIComponent(detail()):'';
  return jobs.filter(job=>{
    if(job.id===targeted) return true;
    if(!job.active&&!job.lead||job.hidden&&!view.showHidden||tracked.has(job.id)&&!view.includeApplied) return false;
    if(!preferenceDecision(job,config.preferences).eligible) return false;
    if(query&&!normalized([job.title,job.company,job.location].join(' ')).includes(query)) return false;
    const age=freshness(job,config.preferences.freshnessHours);
    return view.verifiedOnly?age==='verified':age!=='older';
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
    el('div',{class:'results-bar'},el('strong',{},jobs.length.toLocaleString()+' '+(jobs.length===1?'job':'jobs')),el('span',{class:'meta'},active+' active '+(active===1?'source':'sources'))),
    jobs.length?el('ul',{class:'result-list','aria-label':'Discovered jobs'},subset.map(job=>jobRow(job,data.config,tracked.get(job.id)))) :
      blank(hasListings?'No matching jobs':'Connect a job source',hasListings?'Try a different search or adjust your preferences.':'Choose company boards, a supported feed, or import a job you found elsewhere.',
        !hasListings&&button('Browse sources',()=>sourceDialog(data),'primary')),
    jobs.length>subset.length&&el('div',{class:'actions',style:'margin-top:12px'},button('Show '+Math.min(70,jobs.length-subset.length)+' more',()=>{view.limit+=70;redrawResults();}))
  ].filter(Boolean);
}
function jobRow(job,config,tracked) {
  const age=freshness(job,config.preferences.freshnessHours);
  const sponsor=job.sponsorship?.status??'Unknown';
  const label=job.lead?'Review lead':niceAge[age];
  const salary=job.salary;
  return el('li',{class:'job-row','data-highlight':String(detail()===job.id)},
    el('div',{},
      el('div',{class:'inline-group'},el('strong',{},job.company||'Unknown employer'),badge(label,age==='verified'?'ok':age==='detected'?'warn':'muted'),
        tracked&&badge(tracked.status,stageStyle(tracked.status)),job.identityReview&&badge('Identity needs review','warn'),job.hidden&&badge('Hidden')),
      el('h2',{},button(job.title,()=>jobDetails(job,config),'quiet',{style:'padding:0;min-height:0;font-size:inherit;text-align:left;justify-content:start'})),
      el('p',{class:'meta'},[job.location||'Location unknown',job.workMode,job.employmentType,job.attribution,salary?.max?(salary.currency||'')+' '+salary.max.toLocaleString()+(salary.period?' / '+salary.period:''):null].filter(Boolean).join(' · ')),
      el('p',{class:'meta'},age==='verified'||age==='older'?'Posted '+dateLabel(job.postedAt):'First seen '+dateLabel(job.firstSeenAt),' · Sponsorship '+sponsor.toLowerCase())),
    el('div',{class:'row-end'},
      badge(job.match?job.match.score+' / 100 match':'Unscored',job.match?'ok':'muted'),
      el('div',{class:'actions'},button(job.hidden?'Unhide':'Hide',task(()=>db.jobs.update(job.id,{hidden:!job.hidden})),'quiet',{'aria-label':(job.hidden?'Unhide ':'Hide ')+job.title}),
        tracked?button('View',()=>showApplication(tracked)) : button('Save',task(async()=>{
          const result=await saveApplication(null,{jobId:job.id});if(result.duplicate)toast('This job is already tracked.');else toast('Saved to Tracker.');
        }),'' ,{'aria-label':'Save '+job.title}),
        link(job.official?'Apply':'Open lead',job.url,'button primary'))));
}
function jobDetails(job,config) {
  const sponsor=job.sponsorship;
  const {dialog}=formDialog(job.title,[
    el('p',{},job.company+(job.location?' · '+job.location:'')),
    el('dl',{class:'detail-list'},el('dt',{},'First seen'),el('dd',{},dateLabel(job.firstSeenAt)),
      el('dt',{},'Original posting'),el('dd',{},job.postedAt?dateLabel(job.postedAt):'Unknown'),
      job.lastAbsentAt&&el('dt',{},'Board appeared between'),job.lastAbsentAt&&el('dd',{},dateLabel(job.lastAbsentAt)+' and '+dateLabel(job.firstSeenAt)),
      job.dateEvidence&&el('dt',{},'Timestamp evidence'),job.dateEvidence&&el('dd',{},job.dateEvidence.kind||'Source timestamp', ' · ',link('Source',job.dateEvidence.url)),
      el('dt',{},'Sponsorship'),el('dd',{},sponsor?.status??'Unknown')),
    job.evidence&&paragraph(job.evidence),
    sponsor?.items?.length>0&&el('ul',{class:'stack'},sponsor.items.map(item=>el('li',{},item.scope+' · '+item.text,' ',link('Evidence',item.url)))),
    job.match?el('div',{class:'stack'},el('h3',{},job.match.score+' / 100 match · '+job.match.confidence+' confidence'),
      paragraph('Skills '+job.match.skills+' · Experience '+job.match.experience+' · Experience level '+job.match.seniority+' · Domain '+job.match.domain),
      el('ul',{},[...job.match.strengths,...job.match.gaps].map(item=>el('li',{},item)))):paragraph(job.analysisError||'This job is unscored.'),
    job.jd&&el('details',{},el('summary',{},'Job description excerpt'),paragraph(job.jd.slice(0,12500),'meta')),
    el('div',{class:'actions'},link(job.official?'Apply':'Open source',job.url,'button primary'),
      job.jd&&button('Evaluate with Claude',task(async()=>{await rpc('job:evaluate',{id:job.id});dialog.close();jobDetails(await db.jobs.get(job.id),config);}), '')),
      button('Add sponsorship evidence',()=>{dialog.close();evidenceDialog(job);},'quiet')
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
    paragraph('Connect public boards and feeds. Each origin needs your permission.'),
    el('div',{class:'actions'},button('Add or test URL',()=>{dialog.close();urlSource();},'primary'),
      button('Browse catalog',()=>{dialog.close();catalogDialog();}),button('Import source pack',()=>{dialog.close();sourceImport();}),
      button('Export CSV',()=>download('meshjob-sources.csv',sourcesCSV(current))),
      button('Export source pack',()=>download('meshjob-sources.json',JSON.stringify({format:'MeshJob sources',version:1,sources:sourcePack(current)},null,2),'application/json'))),rows
  ]);
  const live=liveQuery(()=>db.sources.toArray()).subscribe(next=>{current=next;rows.replaceChildren(sourceRows(next));});
  dialog.addEventListener('close',()=>live.unsubscribe(),{once:true});
}
function sourceRows(sources) {
  if(!sources.length) return paragraph('No sources configured.');
  return el('div',{class:'stack'},sources.sort((a,b)=>a.name.localeCompare(b.name)).map(row=>{
    const state=row.enabled?(row.error?'Error':row.inProgressAt?'Checking':row.lastCompleteAt?'Enabled':'Waiting'):'Disabled';
    const edit=()=>formDialog(row.name,[
      field('Check interval in minutes',input('interval',row.interval,{type:'number',min:10,max:1440,required:true})),
      check('enabled','Enable this source',row.enabled),
      el('p',{class:'meta'},link('Open careers page',row.url)),paragraph('Source changes apply to future checks.')
    ],async (values)=>{
      if(values.enabled&&!row.enabled) await permit([origin(row.endpoint)]);
      await rpc('sources:edit',{id:row.id,enabled:!!values.enabled,interval:values.interval});toast('Source updated.');
    });
    return el('div',{class:'section'},el('div',{class:'flex between'},el('h3',{},row.name),badge(state,state==='Error'?'hot':state==='Enabled'?'ok':'muted')),
      paragraph(row.provider+' · every '+row.interval+' min','meta'),
      row.lastCompleteAt&&paragraph('Last complete check '+dateLabel(row.lastCompleteAt),'meta'),
      row.lastAttemptAt&&paragraph('Last attempt '+dateLabel(row.lastAttemptAt),'meta'),
      row.enabled&&row.nextAt&&paragraph('Next eligible check '+dateLabel(new Date(row.nextAt).toISOString()),'meta'),
      row.error&&paragraph(row.error,'form-error'),
      el('div',{class:'actions'},button('Settings',edit),row.enabled&&button('Check now',()=>runDialog('Check '+row.name,'sources:refresh',{id:row.id,full:true},result=>result.errors[0]?.error||(result.checked?'Check completed.':'Check already in progress.'))),
        button('Remove',()=>formDialog('Remove source',[paragraph('The source will stop checking. Tracked applications and history remain available.')],async()=>{await rpc('sources:edit',{id:row.id,remove:true});toast('Source removed.');},'Remove source'),'danger')));
  }));
}
function urlSource() {
  const url=input('url','',{type:'url',required:true,placeholder:'https://…'});
  const provider=select('provider',[['','Detect automatically'],['rss','RSS or Atom'],['careers','Careers page']],'');
  const allowed=check('permitted','I verified that the Workday site permits automated public listing checks.');
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
  const selected=el('div',{class:'form-grid'},catalog.map((source,i)=>el('div',{},check('board-'+i,source.name,false),el('small',{},source.method))));
  formDialog('Recommended job sources',[
    paragraph('Select public boards for your search. The RSS and new-grad lists are optional.'),
    button('Select all company boards',()=>{for(const [i,source] of catalog.entries())if(!source.optional&&!known.has(source.id))selected.querySelector('[name=board-'+i+']').checked=true;}),
    selected
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
    previews.replaceChildren(paragraph(usable.length+' sources ready. '+(rows.length-usable.length)+' Workday sources require individual review.'),
      usable.slice(0,12).map(row=>paragraph(row.name+' · '+row.provider,'meta')),
      button('Grant access and import',task(async()=>{
        await permit(usable.map(row=>origin(row.endpoint)));
        const count=await rpc('sources:add',{entries:usable});dialog.close();toast(count+' new sources imported.');
      }),'primary'));
    return false;
  },'Preview sources');
}
function tracker(data) {
  return el('div',{class:'stack large'},
    pageHead('Tracker','Applications and follow-ups',[
      button('Import CSV',()=>applicationImport()),button('Export',()=>exportDialog(data)),
      button('Add application',()=>applicationEditor(),'primary')
    ]),
    el('div',{class:'toolbar'},el('div',{class:'segmented','aria-label':'Tracker view'},[
      ['table','Table'],['status','Status'],['calendar','Calendar']
    ].map(([key,label])=>button(label,event=>{
      view.trackerMode=key;view.limit=70;
      for(const control of event.currentTarget.parentElement.children)control.setAttribute('aria-pressed',String(control===event.currentTarget));
      redrawResults();
    },'',{'aria-pressed':String(view.trackerMode===key)}))),
      smallSearch('tracker-query',view.trackQuery,'Search applications',value=>{view.trackQuery=value;view.limit=70;redrawResults();}),
      select('trackerStage',[['','All statuses'],...STAGES],view.stage,{'aria-label':'Filter by status'}),
      button('Action required',()=>{const queue=document.querySelector('#action-queue');if(queue){queue.open=true;queue.scrollIntoView({block:'start'});}},'quiet')),
    el('div',{id:'view-results',class:'stack large'},trackerResults(data))
  );
}
const matchingApps=apps=>apps.filter(app=>(!view.stage||view.stage===app.status)&&
  (!view.trackQuery||normalized([app.company,app.title,app.requisition,app.location,app.notes,app.source].join(' ')).includes(normalized(view.trackQuery))))
  .sort((a,b)=>(b.appliedAt||b.updatedAt).localeCompare(a.appliedAt||a.updatedAt));

const dateOnly=new Intl.DateTimeFormat(undefined,{dateStyle:'medium'});
const shortDate=timestamp=>timestamp?dateOnly.format(new Date(timestamp)):'—';
const openApplication=(app,label=app.title)=>button(label,()=>showApplication(app),'quiet application-link',{
  'aria-label':label===app.title?app.title:'Open '+app.company
});
const applicationStatus=app=>el('div',{class:'inline-group'},badge(app.status,stageStyle(app.status)),
  app.submission==='needs_check'&&badge('Needs Check','warn'),app.review&&badge('Conflict','warn'));
function applicationTable(apps,total) {
  return dataTable(['Company','ID','Job title','Experience level','Priority','Location','Applied date','Job URL','Resume','Status','Source'],
    apps.map(app=>[
      openApplication(app,app.company),app.requisition||'—',el('div',{class:'actions'},
        openApplication(app),button('Edit',task(async()=>{
          const job=app.jobDescription===undefined?await db.jobs.get(app.jobId):null;
          applicationEditor(app,app.jobDescription??job?.jd??'');
        }),'quiet',{'aria-label':'Edit '+app.title})),
      app.seniority||'—',app.priority?badge(app.priority,app.priority==='High'?'warn':'muted'):'—',
      el('div',{},app.location||app.workMode||'—',app.workMode&&app.location&&app.workMode!==app.location&&el('small',{class:'block'},app.workMode)),
      shortDate(app.appliedAt),app.url?link('Open job',app.url,'text-link'):'—',
      app.materials?.resume?.name||'—',applicationStatus(app),app.source||'—'
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
function applicationCalendar(apps) {
  const {month}=view;
  const first=new Date(month.getFullYear(),month.getMonth(),1);
  const count=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
  const offset=(first.getDay()+6)%7;
  const localKey=date=>[date.getFullYear(),date.getMonth(),date.getDate()].join('/');
  const byDay=new Map();
  for(const app of apps) {
    if(!app.appliedAt)continue;
    const key=localKey(new Date(app.appliedAt));
    const group=byDay.get(key)??[];
    group.push(app);byDay.set(key,group);
  }
  const shift=amount=>{view.month=new Date(first.getFullYear(),first.getMonth()+amount,1);redrawResults();};
  const title=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(first);
  const headings=Array.from({length:7},(_,i)=>new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(new Date(2026,0,5+i)));
  return el('section',{class:'section tracker-calendar','aria-label':'Application calendar'},
    el('div',{class:'flex between'},el('h2',{},title),el('div',{class:'actions'},
      button('‹',()=>shift(-1),'icon',{'aria-label':'Previous month'}),button('Today',()=>{view.month=new Date();redrawResults();}),
      button('›',()=>shift(1),'icon',{'aria-label':'Next month'}))),
    el('div',{class:'calendar-grid'},headings.map(text=>el('div',{class:'calendar-weekday'},text)),
      Array.from({length:Math.ceil((offset+count)/7)*7},(_,i)=>{
        const number=i-offset+1;
        const date=new Date(first.getFullYear(),first.getMonth(),number);
        const items=byDay.get(localKey(date))??[];
        return number<1||number>count?el('div',{class:'calendar-outside','aria-hidden':'true'}):
          el('div',{class:'calendar-day '+(localKey(date)===localKey(new Date())?'calendar-today':''),'aria-label':shortDate(date)},
            el('span',{},number),items.map(app=>openApplication(app,app.company)));
      })));
}
function trackerResults(data) {
  const reversed=new Set(data.events.filter(event=>event.kind==='undo').map(event=>event.reverses));
  const pending=data.events.filter(event=>event.urgent&&!reversed.has(event.id)&&(view.includeResolved||!event.resolvedAt));
  const unlinked=data.events.filter(event=>!event.urgent&&event.review&&!event.applicationId&&!reversed.has(event.id));
  const apps=matchingApps(data.apps);
  const appNames=new Map(data.apps.map(app=>[app.id,app.company+' · '+app.title]));
  const openActions=pending.filter(event=>!event.resolvedAt).length;
  const contents=view.trackerMode==='calendar'?applicationCalendar(apps):
    apps.length?(view.trackerMode==='status'?statusBoard(apps.slice(0,view.limit)):applicationTable(apps.slice(0,view.limit),apps.length)):
      blank('No applications here',view.trackQuery||view.stage?'Adjust the search or status filter.':'Saved jobs and prepared applications appear here.',button('Add application',()=>applicationEditor(),'primary'));
  return [
    el('details',{class:'section tracker-queue',id:'action-queue',open:openActions>0||detail()==='actions'||view.includeResolved},
      el('summary',{},'Action required ',openActions>0&&badge(String(openActions),'hot')),check('resolved','Show resolved actions',view.includeResolved),
      pending.length?el('ul',{class:'actions-list'},pending.sort((a,b)=>b.at.localeCompare(a.at)).map(event=>actionRow(event,appNames))):paragraph('No open actions.')),
    unlinked.length>0&&section('Email review',el('ul',{class:'actions-list'},unlinked.slice(0,30).map(event=>actionRow(event,appNames)))),
    contents,
    view.trackerMode!=='calendar'&&apps.length>view.limit&&button('Show more applications',()=>{view.limit+=70;redrawResults();})
  ].filter(Boolean);
}
function actionRow(event,appNames) {
  const status=event.resolvedAt?'Resolved':event.acknowledgedAt?'Acknowledged':'Open';
  return el('li',{class:'action-row'+(event.acknowledgedAt?' acknowledged':'')},
    el('div',{class:'flex between'},el('strong',{},event.subject||event.category||'Recruiting message'),event.urgent&&badge(status,status==='Open'?'hot':'muted')),
    paragraph((appNames.get(event.applicationId)||'Unlinked · needs review')+' · '+dateLabel(event.at),'meta'),
    event.urgent&&paragraph(event.deadline?'Deadline '+event.deadline.text+(event.deadline.timezone?'':' · timezone unknown'):'Deadline unknown','meta'),
    event.excerpt&&paragraph(event.excerpt),
    el('div',{class:'actions'},link('Open email',event.url,'button'),!event.resolvedAt&&event.urgent&&!event.acknowledgedAt&&button('Acknowledge',task(()=>rpc('action:status',{id:event.id,operation:'ack'}))),
      event.urgent&&button(event.resolvedAt?'Reopen':'Resolve',task(()=>rpc('action:status',{id:event.id,operation:event.resolvedAt?'reopen':'resolve'}))),
      event.review&&button('Review match',()=>emailReview(event)),
      !event.urgent&&button('Undo sync',task(()=>undoEvent(event.id)),'quiet')));
}
async function emailReview(event) {
  const apps=await db.applications.toArray();
  formDialog('Review email association',[
    paragraph(event.subject),paragraph(event.excerpt),link('Open email',event.url),
    field('Application',select('application',[['','Choose an application'],...apps.map(app=>[app.id,app.company+' · '+app.title])],event.applicationId??'')),
    field('Stage change · optional',select('stage',[['','Keep current stage'],...STAGES],'')),paragraph('Confirm the stage only when the message supports it.')
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
  formDialog('Delete application',[
    paragraph(app.company+' · '+app.title),
    paragraph('Delete this application and its Tracker history? The job and saved documents will remain.')
  ],async()=>{
    await deleteApplication(app.id);
    toast('Application deleted.');
  },'Delete application');
}
function applicationEditor(app,description='') {
  const applied=app?.appliedAt?new Date(app.appliedAt):null;
  const originalDate=applied?new Date(applied.getTime()-applied.getTimezoneOffset()*60_000).toISOString().slice(0,16):'';

  const formFields={};
  for(const [name,value] of Object.entries({company:app?.company,title:app?.title,url:app?.url,requisition:app?.requisition,location:app?.location,source:app?.source})) {
    formFields[name]=input(name,value,{required:['company','title'].includes(name),type:name==='url'?'url':'text'});
  }
  const {dialog}=formDialog(app?'Edit application':'Add application',[
    el('div',{class:'form-grid'},field('Company',formFields.company),field('Job title',formFields.title),field('Job URL',formFields.url),field('Requisition ID',formFields.requisition),field('Location',formFields.location),field('Source',formFields.source),
      pickOptional('seniority','Experience level',EXPERIENCE_LEVELS,app?.seniority),
      pickOptional('workMode','Workplace type',WORKPLACE_TYPES,app?.workMode),
      pickOptional('priority','Priority',PRIORITIES,app?.priority)),
    button('Read public job URL',task(async()=>{
      const url=formFields.url.value;const parsed=httpUrl(url);
      if(!parsed||parsed.protocol!=='https:')throw new Error('Enter an HTTPS job URL.');
      await permit([origin(url)]);
      const details=await rpc('job:url-preview',{url});
      for(const [key,value] of Object.entries(details)) if(value && formFields[key]&&!formFields[key].value) formFields[key].value=value;
      toast('Job details loaded.');
    })),
    el('div',{class:'form-grid'},field('Current stage',select('stage',STAGES,app?.status??'Saved')),
      field('Actual submission date · optional',input('date',originalDate,{type:'datetime-local'}))),

    field('Notes',textarea('notes',app?.notes??'')),
    el('details',{},el('summary',{},'Job description'),
      field('Job description · optional',textarea('jobDescription',description,{rows:7,maxlength:JOB_DESCRIPTION_LIMIT,
        placeholder:'Paste the job description here'}))),
    app&&el('div',{class:'actions'},button('Delete application',()=>{dialog.close();confirmDeleteApplication(app);},'danger'))
  ],async values=>{
    if(!app&&!values.jobDescription.trim()) delete values.jobDescription;
    const tracking=app?{stage:values.stage,submissionDate:values.date===originalDate?undefined:values.date?new Date(values.date).toISOString():null}:undefined;
    const result=await saveApplication(values,{existingId:app?.id,tracking});
    if(result.duplicate&&!app){toast('This requisition is already tracked.');dialog.close();showApplication(result.application);return false;}
    if(!app&&values.date) {
      const applied=new Date(values.date).toISOString();
      await changeStage(result.application.id,'Applied',applied);
      if(!['Saved','Preparing','Applied'].includes(values.stage)) await changeStage(result.application.id,values.stage);
    } else if(!app&&values.stage&&values.stage!=='Saved') await changeStage(result.application.id,values.stage);
    if(result.similar) toast('Saved separately. A similar company and role already exists.');
    else toast(app?'Application updated.':'Application added.');
  });
}
async function showApplication(app) {
  const [events,job]=await Promise.all([db.events.where('applicationId').equals(app.id).toArray(),
    app.jobDescription===undefined?db.jobs.get(app.jobId):null]);
  events.sort((a,b)=>b.at.localeCompare(a.at));
  const description=app.jobDescription??job?.jd??'';
  const history=events.filter(event=>event.kind!=='undo');
  const reversals=new Set(events.filter(e=>e.kind==='undo').map(e=>e.reverses));
  const {dialog}=formDialog(app.title,[
    el('div',{class:'flex between'},el('strong',{},app.company),badge(app.status,stageStyle(app.status))),
    el('dl',{class:'detail-list'},el('dt',{},'Requisition'),el('dd',{},app.requisition||'Unknown'),
      el('dt',{},'Submission'),el('dd',{},app.appliedAt?'Recorded '+dateLabel(app.appliedAt):app.submission==='needs_check'?'Needs Check':'Unverified'),
      el('dt',{},'Resume'),el('dd',{},app.materials?.resume?.name||'Unknown'),
      el('dt',{},'Cover letter'),el('dd',{},app.materials?.cover?.name||'Unknown')),
    app.notes&&paragraph(app.notes),
    description&&el('details',{},el('summary',{},'Job description'),paragraph(description,'job-description')),
    app.review&&paragraph('Conflicting stages need your review.','form-error'),
    el('div',{class:'actions'},link('Open job',app.url,'button'),button('Edit details',()=>{dialog.close();applicationEditor(app,description);}),
      button('Update stage',()=>{dialog.close();stageDialog(app);},'primary')),
    el('h3',{},'History'),history.length?dataTable(['Change','Date','Evidence'],history.map(e=>[
      (e.stage||e.category||e.kind)+(reversals.has(e.id)?' · Undone':''),
      timestamp(e.at),el('div',{class:'actions'},e.url&&link('Open',e.url),e.note&&paragraph(e.note),!reversals.has(e.id)&&e.kind!=='stage'&&button('Undo',task(async()=>{
        await undoEvent(e.id);dialog.close();showApplication(await db.applications.get(app.id));
      }),'quiet'))
    ])):paragraph('No recorded events.')
  ]);
}
function stageDialog(app) {
  formDialog('Update application stage',[
    field('Stage',select('stage',STAGES,app.status)),field('Effective date · optional',input('date','',{type:'datetime-local'})),
    field('Why are you updating this?',textarea('note','')),paragraph('Choose Applied only after you submit the application.')
  ],async ({stage,date,note})=>{await changeStage(app.id,stage,date?new Date(date).toISOString():undefined,note);toast('Stage updated.');});
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
    const grid=el('div',{class:'form-grid'},Object.entries(parsed.mapping).map(([key,value])=>
      field(key,select('map-'+key,[['','Ignore'],...parsed.head],value))));
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
function stats({applications,events}) {
  const range=statsPeriod(view.statsRange);
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
      paragraph('No submitted applications in this period.'))
  );
}
