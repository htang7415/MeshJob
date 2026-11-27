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
const databricks='https://www.databricks.com';
const domains=[green,ashby,lever,workday,blueYonder,mockBoard,databricks];
const slug='meshjob-fixture';
const id='13e1e478-6330-47c5-9fb0-d07889111cc2';
const urls={
  greenhouse:green+'/'+slug+'/jobs/111',ashby:ashby+'/'+slug+'/'+id+'/application',
  lever:lever+'/'+slug+'/'+id+'/apply',workday:workday+'/Careers/job/Remote/Program_Coordinator_R123/apply'
};
const defaultConfig={
  profile:{givenName:'Taylor',familyName:'Example',fullName:'Taylor Example',preferredName:'Tay',email:'taylor@example.invalid',city:'Montréal',
    country:'Canada',phone:'555-0191',website:'https://example.invalid/sample',skills:['Python','PyTorch','C++'],experience:[{employer:'Example Company',title:'Coordinator',current:true}],
    education:[{school:'Example College',degree:'Bachelors'}]},preferences:{titles:[]},onboarded:true,advance:true
};
const testToken='sk-ant-meshjob-fixture-value';
const registrationEmail='registration@example.invalid';
const registrationPassword='fixture-registration-only';
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
    await dashboard.getByRole('button',{name:'Set up discovery'}).click();
    await dashboard.getByRole('checkbox',{name:'Add recommended company job boards'}).waitFor();
    await dashboard.getByRole('button',{name:'Cancel',exact:true}).click();
    await dashboard.getByRole('button',{name:'Skip setup'}).click();
    await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();
    await dashboard.getByRole('heading',{name:'Tracker',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Add application'}).first().click();
    await dashboard.getByLabel('Company',{exact:true}).fill('Fixture Health');
    await dashboard.getByLabel('Job title',{exact:true}).fill('Clinical Coordinator');
    await dashboard.getByLabel('Notes',{exact:true}).fill('A sandbox application.');
    await dashboard.getByLabel('Level',{exact:true}).selectOption('Entry');
    await dashboard.getByLabel('Priority',{exact:true}).selectOption('High');
    await dashboard.getByLabel('Workplace type',{exact:true}).selectOption('Hybrid');
    const date=new Date();
    const localTime=new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
    await dashboard.getByLabel('Actual submission date · optional').fill(localTime);
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByRole('button',{name:'Clinical Coordinator',exact:true}).waitFor();
    await dashboard.getByRole('columnheader',{name:'Level'}).waitFor();
    for(const name of ['Resume','Source']) await dashboard.getByRole('columnheader',{name,exact:true}).waitFor();
    await dashboard.screenshot({path:join(run,'tracker-table.png')});
    await dashboard.getByRole('button',{name:'Status',exact:true}).click();
    await dashboard.locator('.status-group').getByRole('heading',{name:/Applied/}).waitFor();
    assert.equal(await dashboard.getByRole('button',{name:'Calendar',exact:true}).count(),0);
    await dashboard.getByRole('button',{name:'Table',exact:true}).click();
    await dashboard.getByRole('link',{name:'Stats',exact:true}).click();
    await dashboard.getByRole('heading',{name:'Stats',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Month',exact:true}).click();
    assert.equal(await dashboard.getByRole('button',{name:'Month',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await dashboard.locator('.metric strong').first().innerText(),'1');
    await dashboard.screenshot({path:join(run,'stats-month.png')});
    await dashboard.getByRole('link',{name:'Settings',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search active',exact:false}).click();
    await dashboard.getByLabel('Mode',{exact:true}).selectOption('Paused');
    await dashboard.getByRole('button',{name:'Update',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search paused',exact:false}).first().waitFor();
    assert.deepEqual(await dashboard.evaluate(()=>chrome.alarms.getAll()),[]);
    await dashboard.getByRole('link',{name:'Discover',exact:true}).click();
    const postedAt=new Date().toISOString();
    for(const [id,title,location] of [
      ['local-engineer','Software Engineer','Toronto, Canada'],
      ['foreign-engineer','Backend Engineer','Tokyo, Japan'],
      ['local-diagnostics','Diagnostics Engineer','Toronto, Canada']
    ]) {
      const url='https://example.com/jobs/'+id;
      await putInStore(dashboard,'jobs',{id,title,location,url,urls:[url],keys:[],sourceIds:[],members:{},
        active:true,official:true,company:'Fixture Employer',postedAt,firstSeenAt:postedAt});
    }
    await dashboard.reload();
    await dashboard.getByRole('button',{name:'Diagnostics Engineer',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Preferences',exact:true}).click();
    const titles=dashboard.getByRole('textbox',{name:'Target job titles'});
    await titles.fill('Software Engineer');await titles.press('Enter');
    await titles.fill('Data Analyst');await titles.press('Enter');
    await titles.fill('[{"interestingType":"INDUSTRY"}]');
    assert.equal(await titles.inputValue(),'');
    await dashboard.getByRole('combobox',{name:'Choose countries',exact:true}).selectOption('Canada');
    await dashboard.getByRole('combobox',{name:'Choose regions or cities',exact:true}).selectOption('Ontario');
    await dashboard.getByRole('combobox',{name:'Choose level'}).selectOption('Entry');
    await dashboard.getByRole('button',{name:'Save preferences'}).click();
    await dashboard.getByRole('dialog',{name:'Preferences'}).waitFor({state:'hidden'});
    await dashboard.getByRole('button',{name:'Diagnostics Engineer',exact:true}).waitFor({state:'hidden'});
    assert.equal(await dashboard.getByRole('button',{name:'Backend Engineer',exact:true}).count(),0);
    await dashboard.getByRole('button',{name:'Software Engineer',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Preferences',exact:true}).click();
    await dashboard.getByRole('button',{name:'Remove Software Engineer'}).waitFor();
    await dashboard.getByRole('button',{name:'Remove Data Analyst'}).waitFor();
    await dashboard.getByRole('button',{name:'Remove Ontario'}).waitFor();
    assert.equal(await dashboard.getByText('Advanced preferences',{exact:true}).count(),0);
    await dashboard.screenshot({path:join(run,'discover-preferences.png')});
    await dashboard.getByRole('button',{name:'Cancel',exact:true}).click();
    await dashboard.getByRole('link',{name:'Settings',exact:true}).click();
    await dashboard.getByRole('heading',{name:'Registration',exact:true}).waitFor();
    for(const label of ['Model','Monthly budget in USD']) assert.equal(await dashboard.getByLabel(label,{exact:true}).count(),1);
    for(const removed of ['Rounds per day','Web searches per round','Daily budget · USD','Recovery window in days','New password'])
      assert.equal(await dashboard.getByText(removed,{exact:true}).count(),0,removed);
    const registrationField=dashboard.getByLabel('Registration email',{exact:true});
    await registrationField.fill(registrationEmail);await registrationField.press('Tab');
    await until(async()=>(await rpc(dashboard,'integrations:status')).registrationEmail===registrationEmail);
    assert.equal(await dashboard.getByRole('heading',{name:'Preferences',exact:true}).count(),0);
    await dashboard.getByRole('button',{name:'Add education',exact:true}).click();
    await dashboard.getByLabel('School',{exact:true}).fill('Fixture University');
    await dashboard.getByLabel('Start month',{exact:true}).fill('2024-09');
    await dashboard.getByLabel('End month',{exact:true}).fill('2026-09');
    await dashboard.getByRole('checkbox',{name:'I currently study here'}).check();
    assert.equal(await dashboard.getByLabel('End month',{exact:true}).isVisible(),false);
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByText('2024-09 — Present',{exact:true}).waitFor();
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
    await dashboard.getByRole('combobox',{name:'Answer',exact:true}).selectOption('No');
    assert.equal(await dashboard.getByRole('dialog').getByRole('checkbox').count(),0);
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByRole('button',{name:'Edit answer: Are you a citizen of the United States?'}).waitFor();
    await dashboard.getByRole('heading',{name:'Cover letters',exact:true}).waitFor();
    await dashboard.getByRole('button',{name:'Add resume',exact:true}).click();
    await dashboard.getByLabel('PDF file',{exact:true}).setInputFiles({name:'fixture-material.pdf',mimeType:'application/pdf',buffer:pdfFixture()});
    await dashboard.getByRole('button',{name:'Save',exact:true}).click();
    await dashboard.getByText('fixture-material.pdf · v1',{exact:true}).waitFor({timeout:25000});
    await dashboard.getByRole('button',{name:'Edit fixture-material.pdf',exact:true}).click();
    await dashboard.getByText('Review or supply extracted text',{exact:true}).click();
    assert.match(await dashboard.getByLabel('Material text').inputValue(),/MeshJob local fixture text/);
    await dashboard.getByRole('button',{name:'Cancel',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search paused',exact:false}).first().click();
    await dashboard.getByLabel('Mode',{exact:true}).selectOption('Finished');
    await dashboard.getByRole('button',{name:'Update',exact:true}).click();
    await dashboard.getByLabel('I want to stop scheduled services.').check();
    await dashboard.getByRole('button',{name:'Finish search',exact:true}).click();
    await dashboard.getByRole('button',{name:'Search finished',exact:false}).first().waitFor();
    assert.deepEqual(await dashboard.evaluate(()=>chrome.alarms.getAll()),[]);
    await context.setOffline(true);
    await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();
    await dashboard.getByRole('button',{name:'Clinical Coordinator',exact:true}).waitFor();
    await dashboard.locator('details.menu summary').first().click();
    await dashboard.getByRole('button',{name:'Export',exact:true}).click();
    const [download]=await Promise.all([dashboard.waitForEvent('download'),dashboard.getByRole('button',{name:'All applications CSV'}).click()]);
    assert.equal(download.suggestedFilename(),'meshjob-applications.csv');
    const [backup]=await Promise.all([dashboard.waitForEvent('download'),dashboard.getByRole('button',{name:'Full backup ZIP'}).click()]);
    const path=join(run,'offline-backup.zip');
    await backup.saveAs(path);
    const {unzipSync}=await import('fflate');
    const files=unzipSync(new Uint8Array(await readFile(path)));
    const records=Buffer.from(files['records.json']).toString();
    assert.ok(!records.includes(registrationEmail)&&!records.includes(registrationPassword));
    const data=JSON.parse(records);
    assert.equal(data.materials.length,1);assert.match(data.materials[0].text,/MeshJob local fixture text/);
    assert.deepEqual(data.settings.preferences.titles,['Software Engineer','Data Analyst']);
    assert.deepEqual(data.settings.preferences.countries,['Canada']);
    assert.deepEqual(data.settings.profile.skills,['Python','PyTorch','C++']);
    assert.equal(data.settings.profile.education[0].start,'2024-09');
    assert.equal(data.settings.profile.education[0].current,true);
    assert.equal(data.settings.profile.education[0].end,undefined);
    assert.equal(data.answers[0].value,'No');
    assert.equal(data.answers[0].verified,true);
    assert.equal(data.settings.profile.experience[0].current,true);
    assert.equal(data.settings.profile.experience[0].end,undefined);
    assert.deepEqual(Buffer.from(files['pdf/'+data.materials[0].hash+'.pdf']),pdfFixture());
    const session=await context.newCDPSession(dashboard);
    await session.send('ServiceWorker.enable');
    await session.send('ServiceWorker.stopAllWorkers');
    await session.detach();
    const reloaded=await context.newPage();
    await reloaded.goto('chrome-extension://'+id+'/dashboard.html#tracker');
    await reloaded.getByRole('button',{name:'Search finished',exact:false}).first().waitFor();
    await reloaded.getByRole('button',{name:'Clinical Coordinator',exact:true}).waitFor();
    const edit=reloaded.getByRole('button',{name:'Edit Clinical Coordinator',exact:true});
    await edit.click();
    const editor=reloaded.getByRole('dialog',{name:'Edit application'});
    await editor.getByLabel('Current stage').selectOption('Interview');
    await editor.getByLabel('Actual submission date · optional').fill('2026-11-23T10:00');
    await editor.getByRole('button',{name:'Save',exact:true}).click();
    await reloaded.getByRole('row').filter({hasText:'Clinical Coordinator'}).getByText('Interview',{exact:true}).waitFor();
    await edit.click();
    assert.equal(await editor.getByLabel('Actual submission date · optional').inputValue(),'2026-11-23T10:00');
    await editor.getByRole('button',{name:'Delete application',exact:true}).click();
    const confirmation=reloaded.getByRole('dialog',{name:'Delete application'});
    await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
    await edit.click();
    await editor.getByRole('button',{name:'Delete application',exact:true}).click();
    await confirmation.getByRole('button',{name:'Delete application',exact:true}).click();
    await edit.waitFor({state:'hidden'});
  } finally {await close();}
});

test('ATS sandbox variants, human-only receipt, Workday progression and warm dashboard',async t=>{
  const dir=join(run,'fixture-extension');
  await cp(baseDist,dir,{recursive:true});
  const manifestPath=join(dir,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // Test extension only: preauthorize the intercepted hosts. The production test checks the real permission defaults.
  manifest.permissions.push('webNavigation');
  manifest.optional_permissions=manifest.optional_permissions.filter(permission=>permission!=='webNavigation');
  manifest.host_permissions=domains.map(origin=>origin+'/*').concat('https://api.anthropic.com/*');
  await writeFile(manifestPath,JSON.stringify(manifest));
  const {context,dashboard,id,close}=await contextFor(dir,'fixture-profile');
  dashboard.setDefaultTimeout(6500);
  const metrics={forms:[],workday:[],warm:[],cold:[],panelSync:{},sandboxRequests:0,externalApplicationRequests:0};
  let hits=0;
  try {
    await context.route('https://www.recaptcha.net/recaptcha/**',route=>route.fulfill({contentType:'text/html',body:'<title>Verification fixture</title>'}));
    await context.route(new RegExp(domains.map(origin=>origin.replaceAll('.','\\.')).join('|')),async route=>{
      const value=new URL(route.request().url());
      if(route.request().method()!=='GET'){metrics.externalApplicationRequests++;await route.abort();return;}
      if(value.origin===mockBoard){hits++;await route.fulfill({json:{jobs:[]}});return;}
      if(value.origin===databricks) {
        const embedded=green+'/embed/job_app?for=databricks&token=8546367002&validityToken=fixture';
        await route.fulfill({contentType:'text/html',body:`<!doctype html><title>AI Engineer - Databricks</title>
          <main><h1>AI Engineer</h1><div>United States<p><button id="apply" type="button">Apply now</button></p></div>
          <div class="rich-text-body"><p><strong>AI Engineer</strong></p><p><strong>CSQ327R177</strong></p><p>Build engineering tools.</p></div>
          <form role="search"><label>Site search <input id="site-search" type="search"></label></form><div id="embed"></div></main>
          <script>document.getElementById('apply').onclick=()=>document.getElementById('embed').innerHTML=
            '<iframe title="Greenhouse Job Board" src="${embedded}"></iframe>';</script>`});
        return;
      }
      if(value.origin===green&&value.pathname==='/embed/job_app') {
        await route.fulfill({contentType:'text/html',body:`<!doctype html><h1>Apply for this job</h1>
          <form id="application" onsubmit="window.meshjobSubmits++;return false">
            <label>First Name <input id="first" required></label>
            <label>Preferred First Name <input id="preferred" required></label>
            <button type="button" id="more">Show more</button><button type="submit">Submit application</button>
          </form><div class="grecaptcha-badge"><iframe title="reCAPTCHA" src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible"></iframe></div>
          <script>window.meshjobSubmits=0;document.getElementById('more').onclick=()=>{
            document.getElementById('more').insertAdjacentHTML('beforebegin','<label>Email <input id="email" type="email" required></label>');
          };</script>`});
        return;
      }
      if(value.origin===blueYonder) {
        await route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><title>Job listing - Logo</title>
          <a data-automation-id="logoLink"><img alt="Logo search for jobs"></a>
          <h1 data-automation-id="jobPostingHeader">Backend Engineer</h1><span data-automation-id="jobReqId">263328</span>
          <script type="application/ld+json">{"@type":"JobPosting","title":"Backend Engineer","hiringOrganization":{"name":""},"description":"<p>Design APIs and verify releases.</p>"}</script>
          <div data-automation-id="jobPostingDescription"><p>Design APIs and verify releases.</p><div>Unrelated overlay</div></div>`});
        return;
      }
      if(value.origin===workday&&value.searchParams.has('registration')) {
        await route.fulfill({contentType:'text/html',body:`<!doctype html><main><h1 data-automation-id="jobPostingHeader">Fixture role</h1>
          <h2 data-automation-id="pageHeaderTitle">Create Account</h2><form onsubmit="window.meshjobSubmits++;return false">
          <label>Email Address <input id="registration-email" type="email" required></label>
          <label>Password <input id="registration-password" type="password" autocomplete="new-password" required></label>
          <label>Confirm Password <input id="confirmation-password" type="password" autocomplete="new-password" required></label>
          <button type="submit">Create account</button></form></main><script>window.meshjobSubmits=0;</script>`});
        return;
      }
      const provider=Object.keys(urls).find(key=>urls[key].startsWith(value.origin));
      const variant=Number(value.searchParams.get('variant')??0);
      metrics.sandboxRequests++;
      await route.fulfill({status:200,contentType:'text/html',body:value.searchParams.has('multi')?workdayFixture():fixture(provider,variant)});
    });
    await rpc(dashboard,'settings:update',{config:defaultConfig});
    const discovered={keys:[],urls:[],sourceIds:[],members:{},active:true,official:false,company:'Media Inc',location:'Remote',lastAbsentAt:new Date(Date.now()-300_000).toISOString()};
    await putInStore(dashboard,'jobs',{...discovered,id:'sort-high',title:'High match role',match:{score:95},firstSeenAt:new Date(Date.now()-60_000).toISOString()});
    await putInStore(dashboard,'jobs',{...discovered,id:'sort-new',title:'New role',firstSeenAt:new Date().toISOString()});
    await dashboard.reload();
    await dashboard.getByRole('button',{name:'New role',exact:true}).waitFor();
    assert.equal(await dashboard.locator('.job-row .job-title').first().innerText(),'New role');
    await dashboard.getByRole('combobox',{name:'Sort by',exact:true}).selectOption('match');
    assert.equal(await dashboard.locator('.job-row .job-title').first().innerText(),'High match role');
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
      await tab.locator('[data-automation-id=bottom-navigation-next-button]').click();
      step=await until(async()=>{const next=await rpc(dashboard,'form:inspect',{tabId:ref.tabId});return next.step===expect&&next;});
      metrics.workday.push(expect);
      ref.inspection=await rpc(dashboard,'form:inspect',{tabId:ref.tabId});
      ref.revision=ref.inspection.revision;
    }
    const noAdvance=await dashboard.evaluate(ref=>chrome.runtime.sendMessage({type:'form:advance',...ref}).catch(()=>undefined),ref);
    assert.ok(!noAdvance?.ok,'automatic Workday advance is removed');
    assert.equal(await tab.evaluate(()=>window.meshjobSubmits),0);
    await tab.close();

    const panel=await context.newPage();
    await panel.goto('chrome-extension://'+id+'/panel.html');
    const panelTarget=await context.newPage();
    await panelTarget.goto(urls.greenhouse.replace('111','390')+'?variant=0');
    await panelTarget.bringToFront();
    const autofill=panel.getByRole('button',{name:/^(Autofill|Fill this page)$/});
    await autofill.waitFor({timeout:7000});
    assert.equal(await panel.getByRole('button',{name:'Prepare application'}).count(),0);
    await autofill.click();
    await panel.getByRole('heading',{name:'Needs you'}).waitFor();
    await until(async()=>await panelTarget.locator('#email').inputValue()===defaultConfig.profile.email);
    await panel.getByText('Preparing',{exact:true}).waitFor();
    assert.equal(await panel.getByLabel('Source',{exact:true}).inputValue(),'Company site');
    await panel.getByRole('button',{name:/Are you authorized to work\?/}).click();
    await until(()=>panelTarget.evaluate(()=>document.activeElement?.name==='authorization'));
    assert.equal(await panelTarget.evaluate(()=>window.meshjobSubmits),0);
    await panel.setViewportSize({width:420,height:780});
    await panel.screenshot({path:join(run,'panel-review.png')});
    await panelTarget.getByText('Yes',{exact:true}).first().click();
    await panelTarget.getByText('Yes',{exact:true}).last().click();
    await panelTarget.getByRole('button',{name:'Submit application'}).click();
    await panel.getByText(/^Applied · /).waitFor();
    await panel.getByRole('heading',{name:/^Save 2 answers/}).waitFor();
    await panel.getByRole('checkbox',{name:/Are you authorized to work\?/}).check();
    await panel.getByRole('button',{name:'Save',exact:true}).click();
    await until(()=>dashboard.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('meshjob');r.onsuccess=()=>{const q=r.result.transaction('answers').objectStore('answers').count();q.onsuccess=()=>{r.result.close();resolve(q.result===1);};};})));
    await panelTarget.close();
    const guidedTarget=await context.newPage();
    await guidedTarget.goto(urls.workday.replace('_R123','_R650')+'?multi=1');
    await guidedTarget.bringToFront();
    await panel.getByText(/^My Information · /).waitFor();
    await autofill.click();
    const employer=panel.getByLabel('Company',{exact:true});
    assert.equal(await employer.inputValue(),'');
    await employer.fill('Sandbox Employer');
    await panel.getByRole('button',{name:'Done',exact:true}).click();
    for(const [next,filled] of [['My Experience','#email'],['Application Questions','#employer1'],['Review','#phone']]) {
      await autofill.click();
      await until(async()=>!!await guidedTarget.locator(filled).inputValue());
      await guidedTarget.locator('[data-automation-id=bottom-navigation-next-button]').click();
      if(next!=='Review') await panel.getByText(new RegExp('^'+next)).waitFor();
    }
    await guidedTarget.locator('#final').waitFor();
    assert.equal(await guidedTarget.evaluate(()=>window.meshjobSubmits),0);
    metrics.guidedReachedReview=true;
    let syncStart=performance.now();
    await guidedTarget.evaluate(()=>{setTimeout(()=>{
      document.querySelector('h2').textContent='Additional Questions';
      document.querySelector('#fields').innerHTML='<label>Portfolio <input required></label>';
    },300);});
    await panel.getByText(/^Additional Questions · .*1 required to fill$/).waitFor({timeout:3000});
    metrics.panelSync.delayedFormMs=performance.now()-syncStart;
    const originalUrl=guidedTarget.url();
    syncStart=performance.now();
    await guidedTarget.evaluate(()=>{
      const heading=document.querySelector('h1');
      window.addEventListener('popstate',()=>{heading.textContent='Program Coordinator';},{once:true});
      history.pushState({},'',location.pathname.replace('_R650','_R651')+location.search);
      heading.textContent='Platform Engineer';
    });
    await panel.getByRole('heading',{name:'Platform Engineer'}).waitFor({timeout:3000});
    metrics.panelSync.sameTabRouteMs=performance.now()-syncStart;
    syncStart=performance.now();
    await guidedTarget.goBack();
    assert.equal(guidedTarget.url(),originalUrl);
    await panel.getByRole('heading',{name:'Program Coordinator'}).waitFor({timeout:3000});
    await panel.getByRole('button',{name:'Fill this page'}).waitFor();
    metrics.panelSync.backMs=performance.now()-syncStart;
    syncStart=performance.now();
    await guidedTarget.reload();
    await panel.getByText(/^My Information · /).waitFor({timeout:3000});
    metrics.panelSync.reloadMs=performance.now()-syncStart;
    await guidedTarget.close();

    await rpc(dashboard,'secret:registration',{email:registrationEmail});
    const registration=await context.newPage();
    await registration.goto(urls.workday.replace('_R123','_R652')+'?registration=1');
    await registration.bringToFront();
    await panel.getByText('Create an account',{exact:true}).waitFor();
    const fillEmail=panel.getByRole('button',{name:'Fill registration email',exact:true});
    await fillEmail.click();
    await panel.getByLabel('Company',{exact:true}).fill('Fixture Employer');
    await panel.getByRole('button',{name:'Done',exact:true}).click();
    await registration.locator('#registration-email').fill('other@example.invalid');
    await fillEmail.click();
    await panel.getByText('No empty email field.',{exact:true}).waitFor();
    await registration.locator('#registration-email').fill('');
    await fillEmail.click();
    await panel.getByText('Email filled.',{exact:true}).waitFor();
    assert.equal(await registration.locator('#registration-email').inputValue(),registrationEmail);
    assert.equal(await registration.locator('#registration-password').inputValue(),'');
    assert.equal(await registration.evaluate(()=>window.meshjobSubmits),0);
    await registration.close();

    const listing=await context.newPage();
    await listing.goto(blueYonder+'/JDA_Careers/job/Dallas/Backend-Engineer_263328-1');
    syncStart=performance.now();
    await listing.bringToFront();
    await panel.getByText('Blue Yonder',{exact:true}).waitFor();
    metrics.panelSync.tabSwitchMs=performance.now()-syncStart;
    await panel.getByRole('button',{name:'Save to Tracker'}).click();
    await panel.getByRole('button',{name:'Open in Full view'}).waitFor();
    assert.equal(await listing.url(),blueYonder+'/JDA_Careers/job/Dallas/Backend-Engineer_263328-1');
    const custom=await context.newPage();
    await custom.goto(databricks+'/company/careers/engineering/ai-engineer-8546367002');
    await custom.bringToFront();
    await panel.getByRole('heading',{name:'AI Engineer',exact:true}).waitFor();
    await panel.getByText('Databricks',{exact:true}).waitFor();
    await custom.getByRole('button',{name:'Apply now'}).click();
    const embed=custom.frameLocator('iframe[title="Greenhouse Job Board"]');
    await panel.getByText(/2 required to fill$/).waitFor();
    await embed.getByRole('button',{name:'Show more'}).click();
    await panel.getByText(/3 required to fill$/).waitFor();
    assert.equal(await autofill.isEnabled(),true);
    assert.equal(await panel.getByText('Verification required',{exact:true}).count(),0);
    await embed.locator('body').evaluate(body=>body.insertAdjacentHTML('beforeend',
      '<div id="active-verification" data-captcha-challenge>Complete the verification</div>'));
    await panel.getByText('Verification required',{exact:true}).waitFor();
    assert.equal(await autofill.isDisabled(),true);
    await embed.locator('#active-verification').evaluate(node=>node.remove());
    await panel.getByText('Verification required',{exact:true}).waitFor({state:'hidden'});
    await autofill.click();
    await panel.getByText('Preparing',{exact:true}).waitFor();
    await panel.getByText('3 filled',{exact:true}).waitFor();
    assert.equal(await embed.locator('#first').inputValue(),'Taylor');
    assert.equal(await embed.locator('#preferred').inputValue(),'Tay');
    assert.equal(await embed.locator('#email').inputValue(),defaultConfig.profile.email);
    assert.equal(await custom.locator('#site-search').inputValue(),'');
    assert.equal(await embed.locator('body').evaluate(()=>window.meshjobSubmits),0);
    await custom.locator('iframe').evaluate(frame=>{const next=new URL(frame.src);next.searchParams.set('revision','2');frame.src=next.href;});
    await panel.getByText(/2 required to fill$/).waitFor();
    await custom.close();
    const ungranted='https://new-employer.example/jobs/first';
    await context.route(ungranted,route=>route.fulfill({contentType:'text/html',body:'<h1>Job on an ungranted site</h1>'}));
    const otherSite=await context.newPage();
    await otherSite.goto(ungranted,{timeout:7000});
    await otherSite.bringToFront();
    await panel.getByText(/click the MeshJob toolbar icon/i).waitFor({timeout:3000});
    assert.equal(await autofill.count(),0);
    await listing.bringToFront();
    await panel.getByText('Blue Yonder',{exact:true}).waitFor({timeout:3000});
    await otherSite.close();
    await listing.close();await panel.close();
    await dashboard.getByRole('link',{name:'Tracker',exact:true}).click();
    await dashboard.getByRole('button',{name:'Backend Engineer',exact:true}).click();
    await dashboard.getByText('Job description',{exact:true}).click();
    assert.equal(await dashboard.locator('.job-description').innerText(),'Design APIs and verify releases.');
    await dashboard.getByRole('button',{name:'Close',exact:true}).first().click();

    await rpc(dashboard,'secret:claude',{key:testToken});
    const zipBytes=await dashboard.evaluate(async ()=>{
      document.querySelector('nav a[href="#settings"]').click();
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
    const preferences=dashboard.getByRole('button',{name:'Preferences',exact:true});
    const dialog=dashboard.getByRole('dialog',{name:'Preferences'});
    await preferences.click();
    await dialog.waitFor();
    await dashboard.screenshot({path:join(run,'discover-preferences-narrow.png')});
    assert.ok(await dialog.locator('.dialog-body').evaluate(body=>body.scrollWidth<=body.clientWidth));
    await dashboard.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.ok(await preferences.evaluate(button=>document.activeElement===button));
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
