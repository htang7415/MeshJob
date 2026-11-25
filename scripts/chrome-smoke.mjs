import { openChrome } from './chrome-cdp.mjs';
import { cp,mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';

const executable=process.env.MESHJOB_BROWSER;
const scratch=process.env.MESHJOB_PROFILE_ROOT??process.env.MESHJOB_TEST_ROOT;
if(!executable||!scratch) throw new Error('Set MESHJOB_BROWSER and MESHJOB_PROFILE_ROOT for a disposable smoke test.');
await mkdir(scratch,{recursive:true});
const profile=await mkdtemp(join(scratch,'release-'));
const extension=resolve(process.env.MESHJOB_DIST??'dist');
const {send,close}=openChrome(executable,profile);
function pdfFixture() {
  const stream='BT /F1 12 Tf 24 100 Td (MeshJob offline material) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let body='%PDF-1.4\n% fixture\n% '+'.'.repeat(180_000)+'\n';
  const offsets=[];
  for(const [index,object] of objects.entries()) {offsets.push(body.length);body+=(index+1)+' 0 obj\n'+object+'\nendobj\n';}
  const xref=body.length;
  body+='xref\n0 6\n0000000000 65535 f \n'+offsets.map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(body+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
}
const results={observedAt:new Date().toISOString(),kind:'fresh installed Chrome smoke'};
try {
  const version=await send('Browser.getVersion');
  results.chrome=version.product;
  const {id}=await send('Extensions.loadUnpacked',{path:extension});
  results.loadedRelease=true;
  const {targetId}=await send('Target.createTarget',{url:'chrome-extension://'+id+'/dashboard.html'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const expr=async expression=>{
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  };
  const until=async expression=>{
    for(let attempt=0;attempt<100;attempt++) {
      const value=await expr(expression);
      if(value)return value;
      await wait(250);
    }
    throw new Error('Timed out on '+expression.slice(0,220)+'\n'+String(await expr('document.body?.innerText')).slice(0,850));
  };
  const click=label=>expr('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==='+JSON.stringify(label)+')?.click()');
  const heading=title=>until("document.querySelector('h1')?.innerText==="+JSON.stringify(title));
  await heading('Discover');
  const grants=await expr('chrome.permissions.getAll()');
  assert.ok((grants.origins??[]).every(pattern=>pattern.startsWith('chrome-extension://')));
  const integrations=await expr("chrome.runtime.sendMessage({type:'integrations:status'})");
  assert.ok(integrations.ok);assert.equal(integrations.value.claude,false);assert.equal(integrations.value.gmailConfigured,false);
  results.withoutHostGrants=true;
  results.withoutCredentials=true;
  await expr("location.hash='#tracker'");
  await heading('Tracker');
  await click('Add application');
  await until("document.querySelector('dialog[open] input[name=company]')!==null");
  await expr("document.querySelector('dialog input[name=company]').value='Fixture Clinic';document.querySelector('dialog input[name=title]').value='Clinical Coordinator'");
  await click('Save');
  await until("document.querySelector('tbody')?.innerText.includes('Clinical Coordinator')");
  await expr("location.hash='#profile'");
  await heading('Profile');
  await click('Add resume');
  await until("document.querySelector('dialog[open] input[type=file]')!==null");
  const pdf=pdfFixture();
  const injectFile=(name,mime,bytes)=>expr(`(() => {
    const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),part=>part.charCodeAt(0));
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:${JSON.stringify(mime)}}));
    const control=document.querySelector('dialog[open] input[type=file]');control.files=transfer.files;control.dispatchEvent(new Event('change',{bubbles:true}));return control.files.length;
  })()`);
  await injectFile('fixture.pdf','application/pdf',pdf);
  await click('Save');
  await until("document.body.innerText.includes('fixture.pdf · revision 1')");
  await click('Edit');
  results.pdfLocalExtraction=await until("document.querySelector('dialog textarea[name=text]')?.value.includes('MeshJob offline material')");
  await click('Cancel');
  const status=await expr("chrome.runtime.sendMessage({type:'mode:set',mode:'Finished',confirm:true})");
  assert.equal(status.ok,true,status.error);
  assert.equal(status.value.mode,'Finished');
  assert.deepEqual(await expr('chrome.alarms.getAll()'),[]);
  await send('Network.enable',{},sessionId);
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0},sessionId);
  await expr(`(() => {
    const allocate=URL.createObjectURL;globalThis.captures={};
    URL.createObjectURL=function(blob) {captures[blob.type]=blob;return allocate.call(this,blob);};
    HTMLAnchorElement.prototype.click=function(){};
  })()`);
  await expr("location.hash='#tracker'");
  await heading('Tracker');
  await click('Export');
  await click('All applications CSV');
  results.offlineCSV=await until("Object.entries(captures).find(([mime])=>mime.startsWith('text/csv'))?.[1].text().then(text=>text.includes('Fixture Clinic'))");
  await click('Full backup ZIP');
  const archived=await until("captures['application/zip']?.arrayBuffer().then(buffer=>Array.from(new Uint8Array(buffer)))");
  const files=unzipSync(Uint8Array.from(archived));
  const records=JSON.parse(Buffer.from(files['records.json']).toString());
  assert.equal(records.applications[0].company,'Fixture Clinic');
  assert.deepEqual(Buffer.from(files['pdf/'+records.materials[0].hash+'.pdf']),pdf);
  results.offlineZIP=true;
  await click('×');
  await expr("location.hash='#profile'");
  await heading('Profile');
  await click('Import backup ZIP');
  await injectFile('meshjob.zip','application/zip',Buffer.from(archived));
  await click('Verify and preview');
  results.backupPreview=await until("document.querySelector('dialog[open]')?.innerText.includes('Checksums verified')");
  await click('×');
  await expr("location.reload()");
  await heading('Profile');
  results.finishedAfterReload=await until("document.querySelector('.mode')?.textContent.includes('Search finished')");
  assert.deepEqual(await expr('chrome.alarms.getAll()'),[]);
  const otherFolder=await mkdtemp(join(scratch,'release-update-'));
  await cp(extension,otherFolder,{recursive:true});
  const manifestPath=join(otherFolder,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  assert.ok(manifest.key);
  const parts=manifest.version.split('.').map(Number);
  parts[parts.length-1]++;
  manifest.version=parts.join('.');
  await writeFile(manifestPath,JSON.stringify(manifest));
  const update=await send('Extensions.loadUnpacked',{path:otherFolder});
  assert.equal(update.id,id);
  const {extensions}=await send('Extensions.getExtensions');
  assert.equal(extensions.filter(candidate=>candidate.name==='MeshJob').length,1);
  results.extensionId=id;
  results.oneInstallAfterFolderChange=true;
  const restored=await send('Target.createTarget',{url:'chrome-extension://'+id+'/dashboard.html#tracker'});
  const restoredSession=await send('Target.attachToTarget',{targetId:restored.targetId,flatten:true});
  for(let attempt=0;attempt<100;attempt++) {
    const inspection=await send('Runtime.evaluate',{
      expression:"document.body?.innerText.includes('Clinical Coordinator')===true && chrome.runtime.getManifest().version",
      returnByValue:true
    },restoredSession.sessionId);
    if(inspection.result.value===manifest.version) {results.recordsRetainedOnUpdate=true;break;}
    await wait(250);
  }
  assert.equal(results.recordsRetainedOnUpdate,true);
} catch(error) {
  results.error=error.message;
  process.exitCode=1;
} finally {
  console.log(JSON.stringify(results,null,2));
  await close();
}
