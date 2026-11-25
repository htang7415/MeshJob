import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { openChrome } from '../scripts/chrome-cdp.mjs';
import { percentile } from '../src/stats.js';

const scratch=process.env.MESHJOB_TEST_ROOT;
const executablePath=process.env.MESHJOB_BROWSER;
if(!scratch) throw new Error('Set MESHJOB_TEST_ROOT to a directory for browser profiles and evidence.');
await mkdir(scratch,{recursive:true});
const run=await mkdtemp(join(scratch,'run-'));
const profileBase=process.env.MESHJOB_PROFILE_ROOT??run;
await mkdir(profileBase,{recursive:true});
const baseDist=resolve(process.env.MESHJOB_DIST??'dist');
const allErrors=[];
const green='https://job-boards.greenhouse.io';
const ashby='https://jobs.ashbyhq.com';
const lever='https://jobs.lever.co';
const workday='https://meshjob-fixture.wd5.myworkdayjobs.com';
const blueYonder='https://jda.wd5.myworkdayjobs.com';
const mockBoard='https://boards-api.greenhouse.io';
const domains=[green,ashby,lever,workday,blueYonder,mockBoard];
const slug='meshjob-fixture';
const id='13e1e478-6330-47c5-9fb0-d07889111cc2';
const urls={
  greenhouse:green+'/'+slug+'/jobs/111',ashby:ashby+'/'+slug+'/'+id+'/application',
  lever:lever+'/'+slug+'/'+id+'/apply',workday:workday+'/Careers/job/Remote/Program_Coordinator_R123/apply'
};
const defaultConfig={
  profile:{givenName:'Taylor',familyName:'Example',fullName:'Taylor Example',email:'taylor@example.invalid',city:'Montréal',
    country:'Canada',phone:'555-0191',website:'https://example.invalid/sample',skills:['Python','PyTorch','C++'],experience:[{employer:'Example Company',title:'Coordinator',current:true}],
    education:[{school:'Example College',degree:'Bachelors'}]},preferences:{titles:[]},onboarded:true,advance:true
};
const testToken='sk-ant-meshjob-fixture-value';
function pdfFixture() {
  const stream='BT /F1 12 Tf 24 100 Td (MeshJob local fixture text) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let body='%PDF-1.4\n% fixture\n% '+'.'.repeat(180_000)+'\n';
  const offsets=[];
  for(const [index,object] of objects.entries()){offsets.push(body.length);body+=(index+1)+' 0 obj\n'+object+'\nendobj\n';}
  const xref=body.length;
  body+='xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(body+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
}
async function contextFor(folder,label) {
  const profile=await mkdtemp(join(profileBase,label+'-'));
  let context,close,cdpId;
  if(process.env.MESHJOB_NATIVE_CHROME==='1') {
    if(!executablePath) throw new Error('MESHJOB_NATIVE_CHROME requires MESHJOB_BROWSER.');
    const chrome=openChrome(executablePath,profile,{socket:true,stderr:null});
    try {
      ({id:cdpId}=await chrome.send('Extensions.loadUnpacked',{path:folder}));
      const endpoint=await until(()=>chrome.socketUrl());
      const browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
      context=browser.contexts()[0];
      close=async()=>{await browser.close().catch(()=>{});await chrome.close();};
    } catch(error) {await chrome.close();throw error;}
  } else {
    context=await chromium.launchPersistentContext(profile,{
      channel:'chromium',executablePath,headless:process.env.MESHJOB_HEADED!=='1',acceptDownloads:true,artifactsDir:join(run,'artifacts'),
      args:['--disable-extensions-except='+folder,'--load-extension='+folder,'--no-first-run','--disable-background-networking','--disable-gpu'],
      timeout:90000
    });
    close=()=>context.close();
  }
  let dashboard;
  try {
    context.on('page',page=>page.on('pageerror',error=>allErrors.push(error.message)));
    const worker=cdpId ? context.serviceWorkers()[0] : context.serviceWorkers()[0]??await context.waitForEvent('serviceworker',{timeout:20000});
    const id=cdpId??new URL(worker.url()).host;
    dashboard=context.pages()[0]??await context.newPage();
    dashboard.on('pageerror',error=>allErrors.push(error.message));
    await dashboard.goto('chrome-extension://'+id+'/dashboard.html',{waitUntil:'commit',timeout:60000});
    await dashboard.getByRole('heading',{name:'Discover',exact:true}).waitFor({timeout:15000});
    return {context,profile,dashboard,id,close};
  } catch(error) {
    const copy=dashboard?await dashboard.locator('body').innerText({timeout:2000}).catch(()=>null):null;
    console.error('Dashboard startup:',JSON.stringify({body:copy?.slice(0,1500),errors:allErrors,url:dashboard?.url()}));
    await close();
    throw error;
  }
}
async function rpc(page,type,data={}) {
  const result=await page.evaluate(({type,data})=>chrome.runtime.sendMessage({type,...data}),{type,data});
  assert.equal(result?.ok,true,result?.error);
  return result.value;
}
async function tabId(dashboard,url) {
  return dashboard.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,url);
}
const receiptMarkers={
  greenhouse:'id="application_confirmation"',ashby:'data-testid="application-submitted"',
  lever:'class="application-confirmation"',workday:'data-automation-id="applicationConfirmation"'
};
const variants=[
  ['First name','Last name','label'],['Given name','Family name','aria'],['Legal first name','Legal last name','input'],
  ['Forename','Surname','wrapped'],['Name','Personal email','autocomplete']
];
function fixture(provider,variant=0) {
  const [first,last,style]=variants[variant%variants.length];
  const layout=Math.floor(variant/variants.length);
  const phone=layout%2?'Telephone number':'Mobile number';
  const city=layout>=2?'Town':'City';
  const field=(id,label,attrs='')=>style==='aria'
    ? '<span id="'+id+'-label">'+label+'</span><input id="'+id+'" aria-labelledby="'+id+'-label" '+attrs+'>'
    : style==='input'?'<input id="'+id+'" placeholder="'+label+'" '+attrs+'>'
    : style==='wrapped'?'<label>'+label+'<input id="'+id+'" '+attrs+'></label>'
    : '<label for="'+id+'">'+label+'</label><input id="'+id+'" '+attrs+'>';
  const confirmation='<section '+receiptMarkers[provider]+'><h2>Application submitted</h2><p>We received your application.</p></section>';
  return '<!doctype html><html lang="en"><title>MeshJob form fixture</title><body><main>'+
    '<h1>Program Coordinator</h1><script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',title:'Program Coordinator',hiringOrganization:{name:'Sandbox Employer'}})+'</script>'+
    '<form id="form" method="post">'+
      (style==='autocomplete'?field('first','Your identity','autocomplete="name" required')+field('last','Last name','autocomplete="family-name" required'):field('first',first,'required')+field('last',last,'required'))+
      field('email','Email address','type="email" required')+field('phone',phone,'type="tel" required')+
      field('city',city,'required')+field('url','Portfolio URL','type="url"')+
      (layout===3?'<div><label id="countryLabel">Country</label><button type="button" id="country" role="combobox" aria-labelledby="countryLabel" aria-controls="countries">Choose country</button><div id="countries" role="listbox" hidden><div role="option" data-value="CA">Canada</div><div role="option" data-value="US">United States</div></div></div>':'<label for="country">Country</label><select id="country" required><option value="">Choose country</option><option value="CA">Canada</option><option value="US">United States</option></select>')+
      '<label for="edited">Preferred name</label><input id="edited" value="Manual edit">'+
      '<fieldset><legend>Are you authorized to work?</legend><label>Yes<input type="radio" name="authorization" value="yes" required></label><label>No<input type="radio" name="authorization" value="no"></label></fieldset>'+
      '<fieldset><legend>Will you require sponsorship?</legend><label>Yes<input type="radio" name="sponsorship" value="yes" required></label><label>No<input type="radio" name="sponsorship" value="no"></label></fieldset>'+
      '<label><input type="checkbox" id="consent">I agree to the privacy notice</label>'+
      '<label for="resume">Resume</label><input id="resume" type="file" accept="application/pdf">'+
      '<div id="adversarial">Thank you for visiting our application portal</div><button type="submit">Submit application</button></form></main>'+
      '<script>window.meshjobSubmits=0;const c=document.getElementById("country"),l=document.getElementById("countries");if(l){c.onclick=()=>l.hidden=false;l.onclick=e=>{c.textContent=e.target.textContent;c.dataset.selectedValue=e.target.dataset.value;e.target.setAttribute("aria-selected","true");l.hidden=true;};}const f=document.getElementById("form");f.addEventListener("submit",event=>{event.preventDefault();window.meshjobSubmits++;f.remove();document.querySelector("main").insertAdjacentHTML("beforeend",'+JSON.stringify(confirmation)+');});</script></body></html>';
}
function workdayFixture() {
  return '<!doctype html><html lang="en"><title>Workday sandbox</title><main><h1>Program Coordinator</h1><h2 data-automation-id="pageHeaderTitle">My Information</h2><div id="fields"></div><button type="button" data-automation-id="bottom-navigation-next-button">Save and Continue</button></main>'+
    '<script>const root=document.getElementById("fields"),steps=["My Information","My Experience","Application Questions","Review"];let step=0;window.meshjobSubmits=0;'+
    'const input=(id,label,extra)=>"<label for="+id+">"+label+"</label><input id="+id+" "+(extra||"")+" >";function render(){document.querySelector("h2").textContent=steps[step];const next=document.querySelector("[data-automation-id=bottom-navigation-next-button]");next.hidden=step===3;'+
    'if(step===0)root.innerHTML=input("email","Email","type=email required")+input("first","First name","required");'+
    'if(step===1){root.innerHTML="<div data-automation-id=workExperienceSection><button type=button data-automation-id=add-button>Add</button></div><div data-automation-id=educationSection><button type=button data-automation-id=add-button>Add</button></div>";'+
    'for(const kind of ["workExperience","education"]){let n=0;const area=root.querySelector("[data-automation-id="+kind+"Section]");area.querySelector("button").onclick=()=>{n++;const html=kind==="workExperience"?input("employer"+n,"Employer","required")+input("title"+n,"Job Title","required")+input("current"+n,"I currently work here","type=checkbox")+input("end"+n,"End date","type=date required"):input("school"+n,"School","required");area.insertAdjacentHTML("beforeend","<section data-automation-id="+kind+"-"+n+">"+html+"</section>");if(kind==="workExperience"){const current=document.getElementById("current"+n),end=document.getElementById("end"+n);current.onchange=()=>{end.required=!current.checked;end.hidden=current.checked;};}};}'+
    `root.insertAdjacentHTML("beforeend",'<div data-automation-id="skillsSection"><div id="tokens"><span data-selected-skill="Python">Python</span></div><label for="skill-query">Skills</label><input id="skill-query" aria-controls="skill-options" role="combobox"><div id="skill-options" role="listbox"></div></div>');`+
    'const search=document.getElementById("skill-query"),options=document.getElementById("skill-options");search.oninput=()=>{options.replaceChildren();for(const name of ["Python","PyTorch","C","C++"]){if(!search.value||!name.toLowerCase().startsWith(search.value.toLowerCase()))continue;const option=document.createElement("button");option.type="button";option.setAttribute("role","option");option.textContent=name;option.onclick=()=>{const tag=document.createElement("span");tag.dataset.selectedSkill=name;tag.textContent=name;document.getElementById("tokens").append(tag);search.value="";options.replaceChildren();};options.append(option);}};}'+
    'if(step===2)root.innerHTML=input("phone","Phone Number","type=tel required");'+
    'if(step===3)root.innerHTML="<button type=submit id=final>Submit application</button>";}'+
    'document.querySelector("[data-automation-id=bottom-navigation-next-button]").addEventListener("click",()=>{step++;render();});render();</script></html>';
}
async function putInStore(page,collection,row) {
  await page.evaluate(async ({collection,row})=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('meshjob');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result;
      const tx=db.transaction(collection,'readwrite');
      tx.objectStore(collection).put(row);
      tx.oncomplete=()=>{db.close();resolve();};
      tx.onerror=()=>reject(tx.error);
    };
  }),{collection,row});
}
const getApp=async(page,id)=>page.evaluate(async id=>new Promise((resolve,reject)=>{
  const r=indexedDB.open('meshjob');r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const db=r.result;const request=db.transaction('applications').objectStore('applications').get(id);
    request.onsuccess=()=>{db.close();resolve(request.result);};request.onerror=()=>reject(request.error);
  };
}),id);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=4000) {
  const end=Date.now()+timeout;
  do{const value=await fn();if(value)return value;await wait(100);}while(Date.now()<end);
  throw new Error('Timed out waiting for browser state.');
}
async function starter(dashboard,tab,provider) {
  await tab.bringToFront();
  const url=tab.url();
  const stored=await until(()=>tabId(dashboard,url));
  const inspection=await rpc(dashboard,'form:inspect',{tabId:stored});
  assert.equal(inspection.job.provider,provider);
  const {application}=await rpc(dashboard,'form:prepare',{tabId:stored,inspection,job:{...inspection.job,title:'Program Coordinator',company:'Sandbox Employer'}});
  return {inspection,applicationId:application.id,tabId:stored,page:inspection.page,revision:inspection.revision};
}
async function planFor(inspection,{workday=false}={}) {
  const {createFillPlan}=await import('../src/form-rules.js');
  return createFillPlan(inspection.fields,{
    profile:defaultConfig.profile,job:{company:'Sandbox Employer'},answers:[
      {verified:true,scope:'global',type:'radio',questionKey:'are you authorized to work',value:'Yes'}
    ],materials:workday?{}:{resume:{name:'fixture.pdf',data:Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}}
  });
}
async function measureWarm(dashboard) {
  return dashboard.evaluate(()=>new Promise(resolve=>{
    performance.clearMarks('meshjob-render');
    const started=performance.now();
    const item=[...document.querySelectorAll('nav a')].find(a=>a.textContent==='Discover');
    item.click();
    const render=()=>{
      const entries=performance.getEntriesByName('meshjob-render');
      if(entries.length) {resolve(entries.at(-1).startTime-started);return;}
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }));
}

test('fresh production build runs without host grants, credentials or external account',async()=>{
  const {context,dashboard,id,close}=await contextFor(baseDist,'production-profile');
  dashboard.setDefaultTimeout(6500);
  try {
    const manifest=await dashboard.evaluate(()=>chrome.runtime.getManifest());
    const permissions=await dashboard.evaluate(()=>chrome.permissions.getAll());
    const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    assert.equal(manifest.version,version);assert.equal(manifest.oauth2,undefined);
    const publicKey=await readFile(new URL('../scripts/extension-public-key.txt',import.meta.url),'utf8');
    assert.equal(manifest.key,publicKey.trim());
    assert.ok((permissions.origins??[]).every(origin=>origin.startsWith('chrome-extension://')),JSON.stringify(permissions));
    await dashboard.getByRole('button',{name:'Skip setup'}).click();
    await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();
    await dashboard.getByRole('heading',{name:'Tracker',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Add application'}).first().click();
    await dashboard.getByLabel('Company',{exact:true}).fill('Fixture Health');
    await dashboard.getByLabel('Job title',{exact:true}).fill('Clinical Coordinator');
    await dashboard.getByLabel('Notes',{exact:true}).fill('A sandbox application.');
    await dashboard.getByLabel('Experience level',{exact:true}).selectOption('Entry level');
    await dashboard.getByLabel('Priority',{exact:true}).selectOption('High');
    await dashboard.getByLabel('Workplace type',{exact:true}).selectOption('Hybrid');
    const date=new Date();
    const localTime=new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
    await dashboard.getByLabel('Actual submission date · optional').fill(localTime);
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByRole('button',{name:'Clinical Coordinator'}).waitFor();
    await dashboard.getByRole('columnheader',{name:'Experience level'}).waitFor();
    await dashboard.screenshot({path:join(run,'tracker-table.png')});
    await dashboard.getByRole('button',{name:'Status',exact:true}).click();
    await dashboard.locator('.status-group').getByRole('heading',{name:/Applied/}).waitFor();
    await dashboard.getByRole('button',{name:'Calendar',exact:true}).click();
    await dashboard.locator('.calendar-grid').getByRole('button',{name:'Open Fixture Health'}).waitFor();
    await dashboard.getByRole('button',{name:'Table',exact:true}).click();
    await dashboard.getByRole('link',{name:'Stats',exact:true}).click();
    await dashboard.getByRole('heading',{name:'Stats',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Month',exact:true}).click();
    assert.equal(await dashboard.getByRole('button',{name:'Month',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await dashboard.locator('.metric strong').first().innerText(),'1');
    await dashboard.screenshot({path:join(run,'stats-month.png')});
    await dashboard.getByRole('button',{name:'Search active',exact:false}).click();
    await dashboard.getByLabel('Mode',{exact:true}).selectOption('Paused');
    await dashboard.getByRole('button',{name:'Update',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search paused',exact:false}).waitFor();
    assert.deepEqual(await dashboard.evaluate(()=>chrome.alarms.getAll()),[]);
    await dashboard.getByRole('link',{name:'Profile',exact:true}).click();
    const titles=dashboard.getByRole('textbox',{name:'Target job titles'});
    await titles.fill('Software Engineer');await titles.press('Enter');
    await titles.fill('Data Analyst');await titles.press('Enter');
    await titles.fill('[{"interestingType":"INDUSTRY"}]');
    assert.equal(await titles.inputValue(),'');
    await dashboard.getByRole('combobox',{name:'Choose countries',exact:true}).selectOption('Canada');
    await dashboard.getByRole('combobox',{name:'Choose regions or cities',exact:true}).selectOption('Ontario');
    await dashboard.getByRole('combobox',{name:'Choose experience level'}).selectOption('Entry level');
    await dashboard.getByRole('button',{name:'Save preferences'}).click();
    await dashboard.getByRole('button',{name:'Remove Software Engineer'}).waitFor();
    await dashboard.getByRole('button',{name:'Remove Data Analyst'}).waitFor();
    await dashboard.getByRole('button',{name:'Remove Ontario'}).waitFor();
    assert.equal(await dashboard.getByText('Advanced preferences',{exact:true}).count(),0);
    await dashboard.screenshot({path:join(run,'profile-preferences.png')});
    await dashboard.getByRole('button',{name:'Add experience',exact:true}).click();
    await dashboard.getByLabel('Employer',{exact:true}).fill('Sandbox Employer');
    await dashboard.getByRole('checkbox',{name:'I currently work in this role'}).check();
    assert.equal(await dashboard.getByLabel('End date',{exact:true}).isVisible(),false);
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByText(/Sandbox Employer/).waitFor();
    const skills=dashboard.getByRole('textbox',{name:'Add skills',exact:true});
    await skills.fill('Python, PyTorch, C++');await skills.press('Enter');
    await dashboard.getByRole('button',{name:'Save skills'}).click();
    await dashboard.getByRole('button',{name:'Remove C++'}).waitFor();
    assert.equal(await dashboard.getByRole('button',{name:/^Set answer: /}).count(),14);
    await dashboard.getByRole('button',{name:'Set answer: Are you a citizen of the United States?'}).click();
    assert.equal(await dashboard.getByLabel('Answer',{exact:true}).inputValue(),'');
    await dashboard.getByLabel('Answer',{exact:true}).fill('Prefer not to answer');
    await dashboard.getByRole('checkbox',{name:'I verified this answer for the question shown.'}).check();
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByRole('button',{name:'Edit answer: Are you a citizen of the United States?'}).waitFor();
    await dashboard.getByRole('heading',{name:'Cover letters',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Add resume',exact:true}).click();
    await dashboard.getByLabel('PDF file',{exact:true}).setInputFiles({name:'fixture-material.pdf',mimeType:'application/pdf',buffer:pdfFixture()});
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByText(/fixture-material.pdf · revision 1/).waitFor({timeout:25000});
    await dashboard.getByRole('button',{name:'Edit',exact:true}).last().click();
    await dashboard.getByText('Review or supply extracted text',{exact:true}).click();
    assert.match(await dashboard.getByLabel('Material text').inputValue(),/MeshJob local fixture text/);
    await dashboard.getByRole('button',{name:'Cancel',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search paused',exact:false}).click();
    await dashboard.getByLabel('Mode',{exact:true}).selectOption('Finished');
    await dashboard.getByRole('button',{name:'Update',exact:true}).click();
    await dashboard.getByLabel('I want to stop scheduled services.').check();
    await dashboard.getByRole('button',{name:'Finish search',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search finished',exact:false}).waitFor();
    assert.deepEqual(await dashboard.evaluate(()=>chrome.alarms.getAll()),[]);
    await context.setOffline(true);
    await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();
    await dashboard.getByRole('button',{name:'Clinical Coordinator'}).waitFor();
    await dashboard.getByRole('button',{name:'Export',exact:true}).click();
    const [download]=await Promise.all([dashboard.waitForEvent('download'),dashboard.getByRole('button',{name:'All applications CSV'}).click()]);
    assert.equal(download.suggestedFilename(),'meshjob-applications.csv');
    const [backup]=await Promise.all([dashboard.waitForEvent('download'),dashboard.getByRole('button',{name:'Full backup ZIP'}).click()]);
    const path=join(run,'offline-backup.zip');
    await backup.saveAs(path);
    const {unzipSync}=await import('fflate');
    const files=unzipSync(new Uint8Array(await readFile(path)));
    const data=JSON.parse(Buffer.from(files['records.json']).toString());
    assert.equal(data.materials.length,1);assert.match(data.materials[0].text,/MeshJob local fixture text/);
    assert.deepEqual(data.settings.preferences.titles,['Software Engineer','Data Analyst']);
    assert.deepEqual(data.settings.preferences.countries,['Canada']);
    assert.deepEqual(data.settings.profile.skills,['Python','PyTorch','C++']);
    assert.equal(data.settings.profile.experience[0].current,true);
    assert.equal(data.settings.profile.experience[0].end,undefined);
    assert.deepEqual(Buffer.from(files['pdf/'+data.materials[0].hash+'.pdf']),pdfFixture());
    const session=await context.newCDPSession(dashboard);
    await session.send('ServiceWorker.enable');
    await session.send('ServiceWorker.stopAllWorkers');
    await session.detach();
    const reloaded=await context.newPage();
    await reloaded.goto('chrome-extension://'+id+'/dashboard.html#tracker');
    await reloaded.getByRole('button',{name:'Search finished',exact:false}).waitFor();
    await reloaded.getByRole('button',{name:'Clinical Coordinator'}).waitFor();
  } finally {await close();}
});

test('ATS sandbox variants, human-only receipt, Workday progression and warm dashboard',async t=>{
  const dir=join(run,'fixture-extension');
  await cp(baseDist,dir,{recursive:true});
  const manifestPath=join(dir,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // Test extension only: preauthorize the intercepted hosts. The production test checks the real permission defaults.
  manifest.host_permissions=domains.map(origin=>origin+'/*').concat('https://api.anthropic.com/*');
  await writeFile(manifestPath,JSON.stringify(manifest));
  const {context,dashboard,id,close}=await contextFor(dir,'fixture-profile');
  dashboard.setDefaultTimeout(6500);
  const metrics={forms:[],workday:[],warm:[],cold:[],sandboxRequests:0,externalApplicationRequests:0};
  let hits=0;
  try {
    await context.route(new RegExp(domains.map(origin=>origin.replaceAll('.','\\.')).join('|')),async route=>{
      const value=new URL(route.request().url());
      if(route.request().method()!=='GET'){metrics.externalApplicationRequests++;await route.abort();return;}
      if(value.origin===mockBoard){hits++;await route.fulfill({json:{jobs:[]}});return;}
      if(value.origin===blueYonder) {
        await route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><title>Job listing - Logo</title>
          <a data-automation-id="logoLink"><img alt="Logo search for jobs"></a>
          <h1 data-automation-id="jobPostingHeader">Backend Engineer</h1><span data-automation-id="jobReqId">263328</span>
          <script type="application/ld+json">{"@type":"JobPosting","title":"Backend Engineer","hiringOrganization":{"name":""},"description":"<p>Design APIs and verify releases.</p>"}</script>
          <div data-automation-id="jobPostingDescription"><p>Design APIs and verify releases.</p><div>Unrelated overlay</div></div>`});
        return;
      }
      const provider=Object.keys(urls).find(key=>urls[key].startsWith(value.origin));
      const variant=Number(value.searchParams.get('variant')??0);
      metrics.sandboxRequests++;
      await route.fulfill({status:200,contentType:'text/html',body:value.searchParams.has('multi')?workdayFixture():fixture(provider,variant)});
    });
    await rpc(dashboard,'settings:update',{config:defaultConfig});
    const discovered={keys:[],urls:[],sourceIds:[],members:{},active:true,official:false,company:'Media Inc',location:'Remote'};
    await putInStore(dashboard,'jobs',{...discovered,id:'sort-high',title:'High match role',match:{score:95},firstSeenAt:new Date(Date.now()-60_000).toISOString()});
    await putInStore(dashboard,'jobs',{...discovered,id:'sort-new',title:'New role',firstSeenAt:new Date().toISOString()});
    await dashboard.reload();
    await dashboard.getByRole('button',{name:'New role',exact:true}).waitFor();
    assert.equal(await dashboard.locator('.job-row h2').first().innerText(),'New role');
    await dashboard.getByRole('combobox',{name:'Sort by',exact:true}).selectOption('match');
    assert.equal(await dashboard.locator('.job-row h2').first().innerText(),'High match role');
    assert.equal(await dashboard.getByLabel('Employment type',{exact:true}).count(),0);
    await dashboard.getByRole('combobox',{name:'Sort by',exact:true}).selectOption('recent');

    for(const provider of Object.keys(urls)) {
      for(let variant=0;variant<20;variant++) {
        const tab=await context.newPage();
        const address=provider==='greenhouse'?urls[provider].replace('111',String(111+variant)):
          provider==='workday'?urls[provider].replace('R123','R'+(123+variant)):
            urls[provider].replace(id,id.slice(0,-2)+variant.toString(16).padStart(2,'0'));
        await tab.goto(address+'?variant='+variant);
        const start=performance.now();
        const ref=await starter(dashboard,tab,provider);
        const plan=await planFor(ref.inspection);
        const result=await rpc(dashboard,'form:fill',{...ref,plan,materials:{}});
        const data=await tab.evaluate(()=>({
          first:document.querySelector('#first').value,last:document.querySelector('#last').value,email:document.querySelector('#email').value,
          phone:document.querySelector('#phone').value,city:document.querySelector('#city').value,url:document.querySelector('#url').value,
          country:document.querySelector('#country').dataset.selectedValue??document.querySelector('#country').value,edited:document.querySelector('#edited').value,consent:document.querySelector('#consent').checked,
          authorized:document.querySelector('[name=authorization]:checked')?.value,sponsor:document.querySelector('[name=sponsorship]:checked')?.value,
          file:document.querySelector('#resume').files[0]?.name,submits:window.meshjobSubmits
        }));
        const expected={first:variant%5===4?'Taylor Example':'Taylor',last:'Example',email:'taylor@example.invalid',phone:'555-0191',
          city:'Montréal',url:'https://example.invalid/sample',country:'CA',edited:'Manual edit',consent:false,
          authorized:'yes',sponsor:undefined,file:'fixture.pdf',submits:0};
        assert.deepEqual(data,expected,provider+' variant '+variant);
        assert.equal((await getApp(dashboard,ref.applicationId)).appliedAt,null);
        metrics.forms.push({provider,variant,standardCorrect:7,standardTotal:7,duration:result.duration,flowMs:performance.now()-start,criticalCorrect:3,criticalTotal:3});
        if(provider==='greenhouse'&&variant===0) {
          await tab.getByText('Yes',{exact:true}).last().click();
          await tab.getByRole('button',{name:'Submit application'}).click();
          await tab.getByRole('heading',{name:'Application submitted'}).waitFor();
          const confirmed=await until(async()=>{
            const app=await getApp(dashboard,ref.applicationId);
            return app.submission==='confirmed'&&app;
          });
          assert.equal(confirmed.status,'Applied');
          assert.equal(await tab.evaluate(()=>window.meshjobSubmits),1);
        }
        await tab.close();
      }
    }
    const tab=await context.newPage();
    await tab.goto(urls.workday.replace('_R123','_R456')+'?multi=1');
    let ref=await starter(dashboard,tab,'workday');
    let step;
    for(const expect of ['My Experience','Application Questions','Review']) {
      if(ref.inspection.step==='My Experience') {
        const rows=await rpc(dashboard,'form:rows',ref);
        await rpc(dashboard,'form:rows',ref);
        assert.equal(await tab.locator('[data-automation-id^=workExperience-]').count(),1);
        assert.equal(await tab.locator('[data-automation-id^=education-]').count(),1);
        ref.inspection.fields=rows;
      }
      const plan=await planFor(ref.inspection,{workday:true});
      const fill=await rpc(dashboard,'form:fill',{...ref,plan});
      assert.equal(fill.unresolved.length,0);
      if(ref.inspection.step==='My Experience') {
        assert.equal(await tab.locator('#current1').isChecked(),true);
        assert.equal(await tab.locator('#end1').isVisible(),false);
        assert.deepEqual(await tab.locator('[data-selected-skill]').allTextContents(),['Python','PyTorch','C++']);
        await rpc(dashboard,'form:fill',{...ref,plan});
        assert.deepEqual(await tab.locator('[data-selected-skill]').allTextContents(),['Python','PyTorch','C++']);
      }
      step=await rpc(dashboard,'form:advance',ref);
      assert.equal(step.step,expect);metrics.workday.push(expect);
      ref.inspection=await rpc(dashboard,'form:inspect',{tabId:ref.tabId});
      ref.revision=ref.inspection.revision;
    }
    const noAdvance=await dashboard.evaluate(ref=>chrome.runtime.sendMessage({type:'form:advance',...ref}),ref);
    assert.equal(noAdvance.ok,false);
    assert.equal(await tab.evaluate(()=>window.meshjobSubmits),0);
    await tab.close();

    const panel=await context.newPage();
    await panel.goto('chrome-extension://'+id+'/panel.html');
    const panelTarget=await context.newPage();
    await panelTarget.goto(urls.greenhouse.replace('111','390')+'?variant=0');
    await panelTarget.bringToFront();
    await panel.getByRole('button',{name:'Prepare application'}).waitFor({timeout:7000});
    await panel.getByRole('button',{name:'Prepare application'}).click();
    await panel.getByRole('button',{name:'Save draft'}).click();
    await panel.getByRole('button',{name:'Fill available fields'}).click();
    await panel.getByRole('heading',{name:'Review autofill'}).waitFor();
    assert.equal(await panelTarget.locator('#email').inputValue(),defaultConfig.profile.email);
    assert.equal(await panelTarget.evaluate(()=>window.meshjobSubmits),0);
    await panel.setViewportSize({width:420,height:780});
    await panel.screenshot({path:join(run,'panel-review.png')});
    await panelTarget.close();
    const guidedTarget=await context.newPage();
    await guidedTarget.goto(urls.workday.replace('_R123','_R650')+'?multi=1');
    await guidedTarget.bringToFront();
    await panel.getByRole('button',{name:'Prepare application'}).click();
    const employer=panel.getByLabel('Company',{exact:true});
    assert.equal(await employer.inputValue(),'');
    await employer.fill('Sandbox Employer');
    await panel.getByRole('button',{name:'Save draft'}).click();
    await panel.getByRole('button',{name:'Fill to review'}).click();
    await guidedTarget.locator('#final').waitFor();
    assert.equal(await guidedTarget.evaluate(()=>window.meshjobSubmits),0);
    metrics.guidedReachedReview=true;
    await guidedTarget.close();

    const listing=await context.newPage();
    await listing.goto(blueYonder+'/JDA_Careers/job/Dallas/Backend-Engineer_263328-1');
    await listing.bringToFront();
    await panel.getByText('Blue Yonder',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Prepare application'}).click();
    assert.equal(await panel.getByLabel('Company',{exact:true}).inputValue(),'Blue Yonder');
    assert.equal(await panel.getByLabel('Requisition ID').inputValue(),'263328');
    await panel.getByText(/Job description detected/).waitFor();
    await panel.getByRole('button',{name:'Save draft'}).click();
    await panel.getByText('Preparing draft saved.',{exact:true}).waitFor();
    assert.equal(await listing.url(),blueYonder+'/JDA_Careers/job/Dallas/Backend-Engineer_263328-1');
    await listing.close();await panel.close();
    await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();
    await dashboard.getByRole('button',{name:'Backend Engineer',exact:true}).click();
    await dashboard.getByText('Job description',{exact:true}).click();
    assert.equal(await dashboard.locator('.job-description').innerText(),'Design APIs and verify releases.');
    await dashboard.getByRole('button',{name:'Close',exact:true}).first().click();

    await rpc(dashboard,'secret:claude',{key:testToken});
    const zipBytes=await dashboard.evaluate(async ()=>{
      document.querySelector('nav a[href="#profile"]').click();
      return chrome.storage.local.get('claudeKey').then(result=>result.claudeKey.length);
    });
    assert.equal(zipBytes,testToken.length);
    const page=await context.newPage();
    const address=urls.greenhouse.replace('111','391');
    await page.goto(address);
    const probe=await until(()=>tabId(dashboard,address));
    const isolated=await dashboard.evaluate(async tabId=>{
      const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:async()=>{
        try{return !!(await chrome.storage.local.get('claudeKey')).claudeKey;}catch{return false;}
      }});
      return result;
    },probe);
    assert.equal(isolated,false);
    await page.close();

    await dashboard.evaluate(async()=>{
      await new Promise((resolve,reject)=>{
        const open=indexedDB.open('meshjob');open.onerror=()=>reject(open.error);open.onsuccess=()=>{
          const db=open.result;const tx=db.transaction('jobs','readwrite');const store=tx.objectStore('jobs');
          for(let i=0;i<3000;i++) store.put({id:'perf-'+i,keys:[],urls:[],sourceIds:[],members:{},active:true,official:false,
            company:'Example '+i%100,title:'Operations Coordinator '+i,location:'Remote',firstSeenAt:new Date(1_795_600_000_000+i).toISOString()});
          tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
        };
      });
    });
    for(let i=0;i<20;i++){
      await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();await dashboard.getByRole('heading',{name:'Tracker',exact:true}).waitFor();
      metrics.warm.push(await measureWarm(dashboard));
    }
    for(let i=0;i<6;i++){
      const page=await context.newPage();
      await page.goto('chrome-extension://'+id+'/dashboard.html');
      await page.getByRole('heading',{name:'Discover',exact:true}).waitFor();
      metrics.cold.push(await page.evaluate(()=>performance.getEntriesByName('meshjob-render')[0].startTime));
      await page.close();
    }
    await dashboard.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
    await dashboard.screenshot({path:join(run,'dashboard-light.png')});
    await dashboard.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
    await dashboard.screenshot({path:join(run,'dashboard-dark.png')});
    await dashboard.setViewportSize({width:480,height:780});
    await dashboard.screenshot({path:join(run,'dashboard-narrow.png')});
    assert.ok(await dashboard.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    const narrowFilters=dashboard.getByRole('button',{name:'Filters',exact:true});
    assert.equal(await narrowFilters.getAttribute('aria-expanded'),'false');
    await narrowFilters.click();
    assert.equal(await narrowFilters.getAttribute('aria-expanded'),'true');
    await narrowFilters.click();
    await dashboard.keyboard.press('Tab');
    assert.ok(await dashboard.evaluate(()=>document.activeElement?.matches('a,button,input,select')));
    assert.equal(metrics.externalApplicationRequests,0);
    assert.equal(hits,0);
    assert.deepEqual(allErrors,[]);
  } finally {
    const values=values=>({n:values.length,p50:percentile(values,.5),p95:percentile(values,.95)});
    Object.assign(metrics,{run,environment:await dashboard.evaluate(()=>navigator.userAgent).catch(()=>null),
      warmSummary:values(metrics.warm),coldSummary:values(metrics.cold),fillSummary:values(metrics.forms.map(row=>row.duration)),flowSummary:values(metrics.forms.map(row=>row.flowMs)),pageErrors:allErrors});
    await writeFile(join(run,'browser-results.json'),JSON.stringify(metrics,null,2)+'\n');
    t.diagnostic('Browser evidence: '+join(run,'browser-results.json'));
    await close();
  }
});
