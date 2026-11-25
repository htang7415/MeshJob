import { cp,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { openChrome } from './chrome-cdp.mjs';
import { CATALOG } from '../src/catalog.js';
import { collect } from '../src/sources.js';

const scratch=process.env.MESHJOB_TEST_ROOT;
if(!scratch) throw new Error('Set MESHJOB_TEST_ROOT for the disposable Chromium profile.');
await mkdir(scratch,{recursive:true});
const run=await mkdtemp(join(scratch,'live-'));
const dir=join(run,'extension');
await cp(resolve(process.env.MESHJOB_DIST??'dist'),dir,{recursive:true});
const manifestPath=join(dir,'manifest.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const origins=['https://boards.greenhouse.io','https://job-boards.greenhouse.io','https://jobs.ashbyhq.com','https://jobs.lever.co'];
manifest.host_permissions=origins.map(origin=>origin+'/*');
await writeFile(manifestPath,JSON.stringify(manifest));

const boardIds=['greenhouse:figma:','greenhouse:anthropic:','ashby:linear:','ashby:ramp:','lever:spotify:us','lever:palantir:us'];
const cases=[];
const selected=process.argv.includes('--ashby')?boardIds.filter(id=>id.startsWith('ashby:')):boardIds;
for(const id of selected){
  const source=CATALOG.find(source=>source.id===id);
  try {
    const data=await collect(source);
    const item=data.items.find(item=>origins.includes(new URL(item.url).origin));
    if(!item) throw new Error('No job URL on a selected official ATS origin.');
    cases.push({provider:source.provider,board:source.name,url:item.url});
  } catch(error) {cases.push({provider:source.provider,board:source.name,error:error.message});}
}
let blockedWrites=0,ashbyReadQueries=0;
const blockedWriteEndpoints=new Set();
const ashbyOperations=new Set();
const results=[];
let browserError;
let context,close,extensionId;
if(process.env.MESHJOB_NATIVE_CHROME==='1') {
  if(!process.env.MESHJOB_BROWSER) throw new Error('Set MESHJOB_BROWSER to your installed Chrome executable.');
  const native=openChrome(process.env.MESHJOB_BROWSER,join(run,'profile'),{socket:true,stderr:null});
  try {
    ({id:extensionId}=await native.send('Extensions.loadUnpacked',{path:dir}));
    if(!native.socketUrl()) throw new Error('Chrome did not expose the local test socket.');
    const browser=await chromium.connectOverCDP(native.socketUrl(),{timeout:15000});
    context=browser.contexts()[0];
    close=async()=>{await browser.close().catch(()=>{});await native.close();};
  } catch(error) {await native.close();throw error;}
} else {
  context=await chromium.launchPersistentContext(join(run,'profile'),{
    channel:'chromium',headless:true,executablePath:process.env.MESHJOB_BROWSER,
    args:['--disable-extensions-except='+dir,'--load-extension='+dir,'--no-first-run','--disable-background-networking'],
    artifactsDir:join(run,'artifacts')
  });
  close=()=>context.close();
}
try {
  if(!extensionId) {
    const [worker]=context.serviceWorkers();
    const service=worker??await context.waitForEvent('serviceworker',{timeout:15000});
    extensionId=new URL(service.url()).host;
  }
  const dashboard=context.pages()[0]??await context.newPage();
  await dashboard.goto('chrome-extension://'+extensionId+'/dashboard.html');
  // Website requests can read public pages. Block any attempted write, including automatic analytics.
  await context.route('**/*',async route=>{
    const request=route.request();
    if(['GET','HEAD','OPTIONS'].includes(request.method())) {await route.continue();return;}
    const url=new URL(request.url());
    if(request.method()==='POST'&&url.origin==='https://jobs.ashbyhq.com'&&url.pathname==='/api/non-user-graphql') {
      try {
        const body=request.postDataJSON();
        const name=String(body?.operationName??url.searchParams.get('op')??'');
        if(/^[A-Za-z][A-Za-z0-9_]{1,72}$/.test(name)) ashbyOperations.add(name);
        const query=String(body?.query??'').trim();
        if(process.argv.includes('--ashby-read-query')&&/^(?:Api)?(?:JobBoard|JobPosting|Careers|ExternalJobPosting)[A-Za-z0-9_]*$/.test(name)&&
          /^query\s/.test(query)&&!/(?:^|[}])\s*(?:mutation|subscription)\b/.test(query)) {
          ashbyReadQueries++;await route.continue();return;
        }
      } catch { /* Unknown requests remain blocked. */ }
    }
    blockedWrites++;
    blockedWriteEndpoints.add(url.origin+(url.pathname.startsWith('/cdn-cgi/challenge-platform')?'/cdn-cgi/challenge-platform':url.pathname.slice(0,120)));
    await route.abort();
  });
  for(const sample of cases) {
    const current={...sample,observedAt:new Date().toISOString()};
    results.push(current);
    if(!sample.url) continue;
    const tab=await context.newPage();
    try {
      let response=await tab.goto(sample.url,{waitUntil:'domcontentloaded',timeout:20000});
      const origin=new URL(tab.url()).origin;
      if(!origins.includes(origin)) throw new Error('Navigated to an origin outside the read-only sample scope.');
      current.http=response?.status();
      await tab.locator('input[type=email],input[autocomplete=email],input[name=email]').first().waitFor({timeout:8500}).catch(()=>{});
      await tab.bringToFront();
      const url=tab.url();
      const inspect=await dashboard.evaluate(async url=>{
        const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
        return tab?chrome.runtime.sendMessage({type:'form:inspect',tabId:tab.id}):null;
      },url);
      if(!inspect?.ok) throw new Error(inspect?.error??'Browser did not expose the active tab.');
      const {fields,challenge,login,registration,job}=inspect.value;
      current.finalUrl=url;current.scanner=job.provider;current.titleFound=!!job.title;
      current.fields=fields.length;current.required=fields.filter(field=>field.required).length;
      current.standardControls=fields.filter(field=>['text','tel','email','url','select','file'].includes(field.type)).length;
      current.challenge=challenge;current.login=login;current.registration=registration;
    }catch(error){current.error=error.message.split('\n')[0];}
    finally {await tab.close();}
  }
} catch(error) {
  browserError=error.message.split('\n')[0];
  process.exitCode=1;
} finally {
  console.log(JSON.stringify({observedAt:new Date().toISOString(),mode:'read only',formsScanned:results.filter(row=>row.fields>0).length,
    pagesAttempted:results.length,blockedWrites,ashbyReadQueries,ashbyOperations:[...ashbyOperations],blockedWriteEndpoints:[...blockedWriteEndpoints],userDataEntered:0,submissions:0,browserError,results},null,2));
  await close();
}
