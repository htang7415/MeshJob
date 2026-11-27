import { db, guarded, settings, updateSettings } from './db.js';
import { CATALOG } from './catalog.js';
import { ATS_ORIGINS, canonicalUrl, httpUrl, list, nowISO, publicUrl, sponsorshipEvidence, uid } from './domain.js';
import { greenhouseEmbed } from './form-rules.js';
import { addMail, disconnectMail, getMailToken, gmailHttp, graphHttp, MAIL_PROVIDERS, mailClient, redirectUri } from './mail.js';
import { portableConfig } from './portability.js';
import { candidateDetails } from './discovery.js';
import { evaluateCandidate, matchPreferences, relevantFacts } from './intelligence.js';
import { collect, detectSource, jsonPostings, plain, postingIdentity } from './sources.js';
import {
  addSources, arm, cancelOperation, claudeFor, notifyUrgent, pattern, previewSource, recordManualRun, registerSchedules, resolveBoards, runSource,
  scopedFetch, setMode, stopMail, stopSource, testNotification, tick
} from './service.js';
import { actionState, appendEvent, expiryEvidence, saveApplication, sourceFromReferrer } from './tracker.js';
import { saveAnswer } from './materials.js';

const base=chrome.runtime.getURL('');
const opened=new Set();
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
void chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
registerSchedules();

async function dashboard(hash='') {
  const [tab]=await chrome.tabs.query({url:base+'dashboard.html*',currentWindow:true});
  if (!tab) return chrome.tabs.create({url:base+'dashboard.html'+hash});
  return chrome.tabs.update(tab.id,{active:true,...(hash?{url:base+'dashboard.html'+hash}:{})});
}
// The toolbar icon always opens the Side Panel (spec 2); Full view is one click away inside it.
chrome.action.onClicked.addListener(tab=>{
  const opened=chrome.sidePanel.open({windowId:tab.windowId});
  void chrome.runtime.sendMessage({type:'panel:access',tabId:tab.id,windowId:tab.windowId}).catch(()=>false);
  void opened.catch(()=>dashboard());
});
chrome.commands?.onCommand.addListener(command=>{if(command==='open-full-view') void dashboard();});
// Highlight the toolbar icon on application pages without host access (declarativeContent).
async function highlightRules() {
  if(!chrome.declarativeContent) return;
  const response=await fetch(chrome.runtime.getURL('icons/icon32.png'));
  const bitmap=await createImageBitmap(await response.blob());
  const canvas=new OffscreenCanvas(32,32), context=canvas.getContext('2d');
  context.drawImage(bitmap,0,0,32,32);
  context.fillStyle='#0a84ff';context.beginPath();context.arc(25,25,6,0,Math.PI*2);context.fill();
  const imageData={32:context.getImageData(0,0,32,32)};
  const hosts=['greenhouse.io','ashbyhq.com','lever.co','myworkdayjobs.com','myworkdaysite.com','smartrecruiters.com','workable.com'];
  const conditions=[...hosts.map(hostSuffix=>new chrome.declarativeContent.PageStateMatcher({pageUrl:{hostSuffix,schemes:['https']}})),
    new chrome.declarativeContent.PageStateMatcher({pageUrl:{schemes:['https']},css:['form input[type="file"]']})];
  await chrome.declarativeContent.onPageChanged.removeRules(undefined);
  await chrome.declarativeContent.onPageChanged.addRules([{conditions,actions:[new chrome.declarativeContent.SetIcon({imageData})]}]);
}
chrome.runtime.onInstalled.addListener(()=>{
  void highlightRules().catch(()=>{});
  void chrome.storage.local.remove('conveniencePassword');void chrome.storage.session.remove('conveniencePassword');
});

chrome.notifications.onClicked.addListener(id=>{
  if (id.startsWith('meshjob:mail:')) void dashboard('#tracker/actions');
  else if (id.startsWith('meshjob:job:')) void dashboard('#discover/'+encodeURIComponent(id.slice('meshjob:job:'.length)));
  else void dashboard();
});

async function sameTab(tabId,expected) {
  const tab=await chrome.tabs.get(tabId);
  if (!tab.active || httpUrl(tab.url)?.protocol!=='https:' || expected && tab.url!==expected) throw new Error('Open the intended job tab and scan it again.');
  return tab;
}
async function sendForm(tabId,type,data={},inject=false) {
  const tab=await sameTab(tabId,data.url);
  if (inject || !opened.has(tabId)) {
    await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['content.js']});
    opened.add(tabId);
  }
  const result=await chrome.tabs.sendMessage(tabId,{type:'form:'+type,...data},{frameId:0});
  if(!result?.ok) throw new Error(result?.error||'Unable to connect to this page.');
  if (type==='inspect' && result.value.page!==tab.url) throw new Error('The tab is opening a different page.');
  if (type!=='advance') await sameTab(tabId,type==='inspect'?tab.url:data.url);
  return result.value;
}
async function embeddedAccess(embedded) {
  return !!chrome.webNavigation && chrome.permissions.contains({
    permissions:['webNavigation'],origins:[embedded.origin+'/*']
  });
}
async function embeddedFrame(tabId,embedded) {
  const frames=await chrome.webNavigation.getAllFrames({tabId});
  const matches=(frames??[]).filter(frame=>{
    if(frame.parentFrameId!==0||frame.documentLifecycle!=='active'||frame.errorOccurred) return false;
    const value=greenhouseEmbed(frame.url);
    return value?.origin===embedded.origin&&value.board===embedded.board&&value.id===embedded.id;
  });
  return matches.length===1?matches[0]:null;
}
async function sendEmbedded(tabId,frame,type,data={}) {
  const result=await chrome.tabs.sendMessage(tabId,{type:'form:'+type,...data,url:frame.url},{documentId:frame.documentId});
  if(!result?.ok) throw new Error(result?.error||'The embedded application changed. Wait for it to be detected.');
  return result.value;
}
function tabState(id) { return db.runtime.get('form-tab:'+id); }
async function setTabState(tab,application,inspection) {
  const existing=await tabState(tab);
  const expectedUrl=inspection?.page||application.url;
  const identity=postingIdentity(expectedUrl);
  const original = httpUrl(application.url);
  if (!original || original.origin!==httpUrl(expectedUrl)?.origin) throw new Error('The tracked application uses a different origin.');
  const prior = postingIdentity(application.url);
  if (prior && identity && prior.key!==identity.key) throw new Error('The page belongs to a different job.');
  const preserve=existing?.appId===application.id && existing?.origin===original.origin;
  const entry={
    id:'form-tab:'+tab,kind:'form',appId:application.id,origin:original.origin,url:expectedUrl,
    provider:identity?.source.provider||inspection?.job.provider||'generic',expiresAt:Date.now()+6*3600000,
    intention:preserve?existing.intention:null,checkpoint:inspection?.step??existing?.checkpoint
  };
  await db.runtime.put(entry);
  return entry;
}
async function pageMessage(message,sender) {
  if (sender.id!==chrome.runtime.id || sender.frameId!==0 || !sender.tab?.id || !httpUrl(sender.url) ||
    sender.url!==message.page && canonicalUrl(sender.url)!==canonicalUrl(message.page)) throw new Error('Invalid form sender.');
  let state=await tabState(sender.tab.id);
  if (message.type==='page:intent' && (!state||state.expiresAt<=Date.now()) && message.job && message.job.provider!=='generic' &&
      postingIdentity(sender.url) && message.job.company && message.job.title) {
    // Submitting without Autofill still tracks the application (spec 6).
    const {application}=await saveApplication({company:message.job.company,title:message.job.title,url:canonicalUrl(sender.url),
      requisition:message.job.requisition,location:message.job.location,attribution:sourceFromReferrer(message.job.referrer,sender.url)},{stage:'Preparing'});
    state=await setTabState(sender.tab.id,application,{page:sender.url,job:{provider:message.job.provider}});
  }
  if (!state||state.expiresAt<=Date.now()||state.origin!==httpUrl(sender.url)?.origin) return null;
  if (message.type==='page:intent') {
    const app=await db.applications.get(state.appId);
    if (!app || (postingIdentity(state.url)?.key && postingIdentity(state.url)?.key !== postingIdentity(sender.url)?.key) ||
      canonicalUrl(state.url)!==canonicalUrl(sender.url)&&!postingIdentity(sender.url)) return null;
    const at=nowISO();
    await db.runtime.update(state.id,{intention:at});
    await recordSubmission(app,message);
    return appendEvent({id:'submit-attempt:'+state.appId,applicationId:state.appId,kind:'needs-check',at,url:canonicalUrl(sender.url)});
  }
  if (message.type==='page:receipt' && state.intention && Date.now()-Date.parse(state.intention)<30*60_000) {
    const evidence=expiryEvidence(message.proof,state,sender.url);
    if (!evidence || !postingIdentity(state.url)) return null;
    return appendEvent({id:'ats-receipt:'+state.appId,applicationId:state.appId,kind:'ats-receipt',stage:'Applied',at:nowISO(),...evidence});
  }
  return null;
}
const fileRef=async name=>{
  const found=(await db.materials.filter(row=>row.name===name).toArray()).sort((a,b)=>b.revision-a.revision)[0];
  return found?{id:found.parentId??found.id,name:found.name,label:found.label,revision:found.revision,hash:found.hash}:{name,external:true};
};
// Record hand-attached files and offer hand-typed answers for reuse.
async function recordSubmission(app,message) {
  const files=Array.isArray(message.files)?message.files.filter(file=>typeof file?.name==='string').slice(0,6):[];
  const resumeFile=files.find(file=>!/cover/i.test(file.label)), coverFile=files.find(file=>/cover/i.test(file.label));
  const materials={resume:app.materials?.resume??null,cover:app.materials?.cover??null};
  let changed=false;
  if(resumeFile&&materials.resume?.name!==resumeFile.name) {materials.resume=await fileRef(resumeFile.name);changed=true;}
  if(coverFile&&materials.cover?.name!==coverFile.name) {materials.cover=await fileRef(coverFile.name);changed=true;}
  if(changed) await appendEvent({id:uid(),applicationId:app.id,kind:'materials',at:nowISO(),materials});
  const answers=(Array.isArray(message.answers)?message.answers:[]).filter(row=>typeof row?.question==='string'&&typeof row.value==='string').slice(0,40)
    .map(({question,value,type,critical})=>({question:question.slice(0,300),value:value.slice(0,400),type:String(type??'').slice(0,40),critical:!!critical}));
  if(answers.length) await db.runtime.put({id:'learn:'+app.id,kind:'learn',appId:app.id,answers,expiresAt:Date.now()+3*86_400_000});
}
chrome.tabs.onRemoved.addListener(id=>{opened.delete(id);void db.runtime.delete('form-tab:'+id);});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{
  if(change.status!=='complete'||!tab.url) return;
  opened.delete(id);
  void (async()=>{
    const state=await tabState(id);
    if(state?.intention && Date.now()-Date.parse(state.intention)<30*60_000 && state.origin===httpUrl(tab.url)?.origin) {
      const identity=postingIdentity(tab.url);
      if (identity && identity.key!==postingIdentity(state.url)?.key) return;
      await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},files:['content.js']});
    }
  })().catch(()=>{});
});
async function formContext(message,app) {
  const state=await tabState(message.tabId);
  const tab=await sameTab(message.tabId,message.page);
  if (!state || state.appId!==app.id || state.expiresAt<=Date.now() || state.origin!==httpUrl(tab.url)?.origin) throw new Error('Prepare this application before filling.');
  const original=postingIdentity(state.url);
  const current=postingIdentity(tab.url);
  if (canonicalUrl(state.url)!==canonicalUrl(tab.url) && !(original && current && original.key===current.key)) {
    throw new Error('The job identity changed.');
  }
  return state;
}
async function materialRefs(ids,result) {
  const entries=await db.materials.bulkGet([ids.resume||'',ids.cover||'']);
  const reference = material=>material ? {id:material.id,name:material.name,label:material.label,revision:material.revision,hash:material.hash} : null;
  const success=key=>entries[key]&&result.results.some(row=>row.state==='filled'&&(row.file===entries[key].name||key===1&&row.materialText));
  return {resume:success(0)?reference(entries[0]):null,cover:success(1)?reference(entries[1]):null};
}
async function integrationPatch(raw) {
  const cleaned=portableConfig(raw);
  const before=await settings();
  const conf=await updateSettings(current=>({...current,...cleaned,
    profile:cleaned.profile?{...current.profile,...cleaned.profile}:current.profile,
    preferences:cleaned.preferences?{...current.preferences,...cleaned.preferences}:current.preferences,
    ...(cleaned.slots?{slots:[...new Set(cleaned.slots)].sort()}:{})
  }));
  // Contact details, posting window and filters do not change a match; only match inputs do (spec 3.4).
  const matchingChanged=JSON.stringify(matchPreferences(before.preferences))!==JSON.stringify(matchPreferences(conf.preferences)) ||
    JSON.stringify(relevantFacts(before.profile))!==JSON.stringify(relevantFacts(conf.profile)) || conf.model!==before.model;
  const filtersChanged=cleaned.preferences && JSON.stringify(before.preferences)!==JSON.stringify(conf.preferences);
  if (matchingChanged||filtersChanged) {
    await db.transaction('rw',db.jobs,db.sources,async()=>{
      if(matchingChanged) await db.jobs.filter(job=>!!job.match||!!job.matchKey).modify(job=>{delete job.match;delete job.matchKey;});
      await db.sources.filter(source=>source.enabled).modify(source=>{
        delete source.etag;delete source.modified;
        source.recheckCandidates=Date.now();
        source.nextAt=Math.min(source.nextAt??Infinity,Date.now()+Math.floor(Math.random()*180000));
      });
    });
  }
  void arm().then(tick).catch(()=>{});
  return conf;
}
const handlers={
  'dashboard': message=>dashboard(message.hash),
  'settings:update': message=>integrationPatch(message.config),
  'mode:set': async message=>{
    if(message.mode==='Finished'&&message.confirm!==true) throw new Error('Confirm that you want to finish the search.');
    return setMode(message.mode);
  },
  'sources:catalog':()=>CATALOG,
  'sources:add':message=>addSources(message.entries),
  'sources:test':message=>previewSource(message.source,message.op),
  'sources:resolve':message=>resolveBoards(Array.isArray(message.names)?message.names:[],message.op),
  'sources:refresh':async message=>{
    const ids=message.id?[message.id]:(await db.sources.filter(source=>source.enabled).toArray()).sort((a,b)=>(a.nextAt??0)-(b.nextAt??0)).map(source=>source.id);
    let checked=0;const errors=[];
    for(const id of ids.slice(0,160)) {
      if(await db.runtime.get('cancel:'+message.op)) break;
      try {const result=await runSource(id,{op:message.op,full:message.full});if(!result?.busy)checked++;}
      catch(error){errors.push({id,error:error.message});if(error.name==='AbortError')break;}
    }
    if(message.op) await db.runtime.delete('cancel:'+message.op);
    return {checked,errors};
  },
  'sources:edit': async message=>{
    const row=await db.sources.get(message.id);
    if(!row) throw new Error('Source was removed.');
    stopSource(row.id);
    if(message.remove) {
      await db.transaction('rw',db.sources,db.jobs,async()=>{
        await db.sources.delete(row.id);
        const jobs=await db.jobs.where('sourceIds').equals(row.id).toArray();
        for(const job of jobs) {
          const members={...job.members};
          if(members[row.id]) members[row.id]={...members[row.id],active:false};
          await db.jobs.update(job.id,{members,sourceIds:job.sourceIds.filter(id=>id!==row.id),
            active:Object.values(members).some(item=>item.active),official:Object.values(members).some(item=>item.active&&item.official)});
        }
      });
      return true;
    }
    const interval=Math.max(10,Math.min(1440,Math.round(Number(message.interval)||row.interval)));
    const enabled=message.enabled===undefined?row.enabled:!!message.enabled;
    if(enabled&&(!await chrome.permissions.contains({origins:[pattern(row.endpoint)]})||row.provider==='workday'&&!row.permitted)) throw new Error('Grant this source origin and verify site permission first.');
    await db.sources.update(row.id,{enabled,interval,nextAt:Date.now()+1000,inProgressAt:null});
    if(enabled) void tick().catch(()=>{});
    return true;
  },
  'operation:cancel': async message=>{
    cancelOperation(message.op);
    if(message.op) await db.runtime.put({id:'cancel:'+message.op,kind:'cancel',expiresAt:Date.now()+60_000});
    return true;
  },
  'secret:claude':async message=>{
    const key=String(message.key??'').trim();
    if(key && (!/^sk-ant-[\w-]+$/.test(key)||key.length>280)) throw new Error('Enter a Claude API key.');
    if(key) await chrome.storage.local.set({claudeKey:key});else await chrome.storage.local.remove('claudeKey');
    return {connected:!!key};
  },
  // Preset sign-up details for ATS account creation; Chrome Password Manager saves the account after sign-up (spec 4).
  'secret:registration':async message=>{
    if(message.email!==undefined) {
      const email=String(message.email??'').trim();
      if(email&&(email.length>254||!(/^[^\s@]+@[^\s@]+$/).test(email))) throw new Error('Enter a valid registration email.');
      if(email) await chrome.storage.local.set({registrationEmail:email});else await chrome.storage.local.remove('registrationEmail');
    }
    if(message.password!==undefined) {
      const password=String(message.password??'');
      if(password.length>256) throw new Error('The password is too long.');
      if(password&&password.length<8) throw new Error('Use at least 8 characters.');
      if(password) await chrome.storage.local.set({registrationPassword:password});else await chrome.storage.local.remove('registrationPassword');
    }
    return true;
  },
  'integrations:status':async ()=>{
    const local=await chrome.storage.local.get(['claudeKey','registrationEmail','registrationPassword','mailAccount','gmailClientId','outlookClientId']);
    return {claude:!!local.claudeKey,registrationEmail:local.registrationEmail??'',registrationPassword:!!local.registrationPassword,mailAccount:local.mailAccount??'',
      clients:{gmail:local.gmailClientId??'',outlook:local.outlookClientId??''},mailRedirect:redirectUri(),extensionId:chrome.runtime.id,
      atsAccess:await chrome.permissions.contains({origins:ATS_ORIGINS})};
  },
  'mail:connect':async message=>{
    const provider=MAIL_PROVIDERS[message.provider]?message.provider:'gmail';
    const token=await getMailToken({provider,interactive:true});
    const account=provider==='outlook'?await graphHttp(token)('/me?$select=mail,userPrincipalName').then(me=>me.mail||me.userPrincipalName):
      (await gmailHttp(token)('/profile')).emailAddress;
    const address=typeof account==='string'?account.slice(0,254):'';
    const {mailAccount}=await chrome.storage.local.get('mailAccount');
    await chrome.storage.local.set({mailAccount:address});
    const previous=await settings();
    // A different mailbox starts fresh: new cursor and reading from now on; reconnecting the same one keeps its start.
    const fresh=!previous.gmail||mailAccount!==address||previous.mailProvider!==provider;
    if(fresh) await db.runtime.bulkDelete(['gmail-cursor','outlook-cursor']);
    await updateSettings({gmail:true,mailProvider:provider,markRead:false,...(fresh||!previous.gmailSince?{gmailSince:nowISO()}:{})});
    void tick().catch(()=>{});
    return {account:address};
  },
  'mail:disconnect':async message=>{
    stopMail();
    const previous=await settings();
    try { await disconnectMail(!!message.revoke,previous.mailProvider); }
    finally {
      await updateSettings({gmail:false,gmailSince:null});
      await db.runtime.bulkDelete(['gmail-cursor','outlook-cursor','health:gmail']);
    }
    return previous.gmail;
  },
  'mail:client':async message=>{
    const spec=MAIL_PROVIDERS[message.provider];
    if(!spec) throw new Error('Choose Gmail or Outlook.');
    const id=String(message.clientId??'').trim();
    if(id&&!spec.client.test(id)) throw new Error(message.provider==='gmail'?'Enter a Google client ID ending in .apps.googleusercontent.com.':'Enter the Application (client) ID, a 36-character ID with dashes.');
    if(id) await chrome.storage.local.set({[message.provider+'ClientId']:id});else await chrome.storage.local.remove(message.provider+'ClientId');
    await chrome.storage.session.remove('mailToken');
    return true;
  },
  'mail:add':async message=>{
    const config=await settings();
    const ai=await claudeFor(config,null).catch(()=>null);
    const result=await addMail(String(message.text??''),{ai});
    await notifyUrgent(null);
    return {duplicate:!!result.duplicate,category:result.event?.category,urgent:!!result.event?.urgent,
      linked:result.application?result.application.company+' · '+result.application.title:null};
  },
  'gmail:sync':message=>recordManualRun('gmail',message.op),
  'search:now':message=>recordManualRun('search',message.op),
  'notification:test':()=>testNotification(),
  'action:status':async message=>{
    await actionState(message.id,message.operation);
    if(message.operation!=='reopen') await chrome.notifications.clear('meshjob:mail:'+message.id);
    await notifyUrgent(null);
    return true;
  },
  'job:description':async message=>{
    const job=await db.jobs.get(message.id);
    if(!job?.official||!job.active||job.identityReview) throw new Error('An active official record is required.');
    const source=(await db.sources.bulkGet(job.sourceIds)).find(source=>source?.enabled&&job.members[source.id]?.active&&job.members[source.id]?.official);
    if(!source) throw new Error('The original source is no longer active.');
    const fetcher=scopedFetch(null,null,source.origin);
    const config=await settings();
    let item={...job,externalId:postingIdentity(job.url)?.externalId??job.externalId};
    if(!['greenhouse','workday'].includes(source.provider)) {
      const snapshot=await collect(source,{fetcher,full:true});
      item=snapshot.items.find(item=>item.key===job.members[source.id].key);
      if(!item) throw new Error('The official source no longer lists this job.');
    }
    const result=await candidateDetails({job,item},source,{config,generation:null,fetcher});
    if(!result.jd) throw new Error('No description is available within your discovery preferences. Use the official link to review the posting.');
    return true;
  },
  'job:evaluate':async message=>{
    const job=await db.jobs.get(message.id), config=await settings();
    if(!job) throw new Error('Job was removed.');
    const provider=await claudeFor(config,null);
    if(!provider) throw new Error('Connect Claude in Profile.');
    const result=await evaluateCandidate(job,config,provider,null);
    if(!result) throw new Error('A matching candidate description is required.');
    return result;
  },
  'job:sponsor':async message=>{
    const job=await db.jobs.get(message.id), url=publicUrl(message.url);
    if(!job||!url||!['history','policy'].includes(message.kind)||!['Likely','Not Supported'].includes(message.status)||
      message.kind==='history'&&message.status!=='Likely') throw new Error('Enter a valid evidence URL and scope.');
    const evidence={scope:'visa sponsorship',kind:message.kind,status:message.status,url:url.href,
      date:message.date||nowISO().slice(0,10),text:String(message.text??'').trim().slice(0,700)};
    if(!evidence.text) throw new Error('Describe the source evidence.');
    const rows=[...(job.userVisaEvidence??[]),evidence].slice(-24);
    await db.jobs.update(job.id,{userVisaEvidence:rows,sponsorship:sponsorshipEvidence(job.jd,job.url,rows)});
    return true;
  },
  'job:url-preview':async message=>{
    const target=publicUrl(message.url);
    if(!target) throw new Error('Enter a public HTTPS URL or fill in the company and job title manually.');
    const identity=postingIdentity(target.href);
    if(identity&&await chrome.permissions.contains({origins:[pattern(identity.source.endpoint)]})&&identity.source.provider!=='workday') {
      const snapshot=await collect(identity.source,{fetcher:scopedFetch(null,null,identity.source.origin)});
      const found=snapshot.items.find(job=>job.keys.includes(identity.key));
      if(found) return {title:found.title,company:found.company,location:found.location,url:target.href,requisition:found.requisition??found.externalId};
    }
    const response=await scopedFetch(null,null,target.origin)(target.href);
    const posting=jsonPostings((await response.text()).slice(0,3_000_000),target.href)[0];
    if(!posting) throw new Error('This page did not expose job details. You can enter the job manually.');
    return {title:posting.title,company:posting.company,location:posting.location,url:target.href,requisition:posting.externalId};
  },
  'form:inspect':async message=>{
    const inspection=await sendForm(message.tabId,'inspect',{watch:!!message.watch},true);
    const {descriptionHtml,...job}=inspection.job;
    inspection.job={...job,jd:descriptionHtml?plain(descriptionHtml)||job.jd:job.jd,attribution:sourceFromReferrer(job.referrer,inspection.page)};
    if(inspection.embedded) {
      inspection.fields=[];
      inspection.embedAccess=await embeddedAccess(inspection.embedded);
      if(inspection.embedAccess) {
        const frame=await embeddedFrame(message.tabId,inspection.embedded);
        if(frame) {
          // A reload between enumeration and injection is handled by the next frame load scan.
          try {
            await chrome.scripting.executeScript({target:{tabId:message.tabId,documentIds:[frame.documentId]},files:['content.js']});
            const form=await sendEmbedded(message.tabId,frame,'inspect',{watch:!!message.watch});
            if(form.page===frame.url) {
              const {fields,revision,step,challenge,login,receipt}=form;
              Object.assign(inspection,{fields,revision,step,challenge:inspection.challenge||challenge,login,registration:false,receipt,
                formDocumentId:frame.documentId});
            }
          } catch { /* Frame is still loading or just navigated. */ }
        }
      }
      await sameTab(message.tabId,inspection.page);
    }
    const local=await tabState(message.tabId);
    if(local && local.expiresAt>Date.now() && local.origin===httpUrl(inspection.page)?.origin) {
      const identity=postingIdentity(inspection.page), prior=postingIdentity(local.url);
      if(canonicalUrl(inspection.page)===canonicalUrl(local.url) || identity && prior && identity.key===prior.key) inspection.sessionAppId=local.appId;
    }
    return inspection;
  },
  'form:prepare':async message=>{
    const {url:page}=await sameTab(message.tabId,message.inspection.page);
    const target=message.existingId ? (await db.applications.get(message.existingId))?.url :
      message.jobId ? (await db.jobs.get(message.jobId))?.url : message.job.url;
    const key=postingIdentity(page)?.key;
    const exact=canonicalUrl(page)===canonicalUrl(target) || !!key && key===postingIdentity(target)?.key;
    const result=await saveApplication(message.job,{stage:message.stage==='Saved'?'Saved':'Preparing',jobId:message.jobId,existingId:message.existingId,
      pageDescription:exact?message.inspection.job.jd:''});
    await setTabState(message.tabId,result.application,message.inspection);
    return result;
  },
  'form:fill':async message=>{
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const data={revision:message.revision,url:message.page,plan:message.plan};
    let result;
    if(message.documentId) {
      const {embedded,challenge}=await sendForm(message.tabId,'embedded',{url:message.page});
      if(challenge) throw new Error('Complete the verification in the employer tab before filling.');
      const frame=embedded && await embeddedAccess(embedded) && await embeddedFrame(message.tabId,embedded);
      if(!frame||frame.documentId!==message.documentId) throw new Error('The embedded application changed. Wait for it to be detected.');
      result=await sendEmbedded(message.tabId,frame,'fill',data);
      await sameTab(message.tabId,message.page);
    } else {
      result=await sendForm(message.tabId,'fill',data);
    }
    const materials=await materialRefs(message.materials??{},result);
    await appendEvent({id:uid(),applicationId:app.id,kind:'autofill',duration:result.duration,at:nowISO()});
    if(materials.resume||materials.cover) await appendEvent({id:uid(),applicationId:app.id,kind:'materials',at:nowISO(),
      materials:{resume:materials.resume??app.materials?.resume??null,cover:materials.cover??app.materials?.cover??null}});
    return result;
  },
  'form:ai':async message=>{
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const config=await settings(), provider=await claudeFor(config,null);
    if(!provider) throw new Error('Connect Claude in Settings.');
    const fields=message.fields.filter(field=>!field.critical&&!field.consent&&!field.filled&&!['password','file','checkbox','skill-picker'].includes(field.type))
      .slice(0,25).map(({id,label,options,type})=>({id,label:String(label).slice(0,240),type,options:(options??[]).slice(0,40).map(value=>String(value).slice(0,120))}));
    if(!fields.length) return [];
    const answers=(await db.answers.toArray()).slice(0,60).map(({question,value})=>({question:question.slice(0,200),value:value.slice(0,300)}));
    const results=await provider.suggestAnswers({fields,facts:relevantFacts(config.profile),answers,role:{title:app.title,company:app.company}});
    const byId=new Map(fields.map(field=>[field.id,field]));
    // A choice answer must be one of the page's own options.
    return results.filter(row=>{
      const field=byId.get(row.id);
      return field&&row.value&&(!field.options.length||field.options.includes(row.value));
    });
  },
  'form:rows':async message=>{
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const config=await settings();
    return sendForm(message.tabId,'rows',{revision:message.revision,url:message.page,
      counts:{experience:config.profile.experience?.length??0,education:config.profile.education?.length??0}});
  },
  'form:focus':async message=>{
    await sameTab(message.tabId,message.page);
    const result=await chrome.tabs.sendMessage(message.tabId,{type:'form:focus',id:message.id},message.documentId?{documentId:message.documentId}:{frameId:0});
    if(!result?.ok) throw new Error(result?.error||'Scan again to find this field.');
    return true;
  },
  'answers:save':async message=>{
    let saved=0;
    for(const row of (message.answers??[]).slice(0,40)) {await saveAnswer({question:row.question,value:row.value});saved++;}
    await db.runtime.delete('learn:'+message.applicationId);
    return saved;
  },
  'form:stop':message=>chrome.tabs.sendMessage(message.tabId,{type:'form:cancel'},message.documentId?{documentId:message.documentId}:{frameId:0}),
  'form:registration':async message=>{
    const state=await sameTab(message.tabId,message.page);
    const identity=postingIdentity(state.url);
    if(!identity||httpUrl(state.url)?.protocol!=='https:') throw new Error('This tab is not a verified ATS registration flow.');
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const [local,config]=await Promise.all([chrome.storage.local.get(['registrationEmail','registrationPassword']),settings()]);
    const email=local.registrationEmail||config.profile.email;
    if(!email&&!local.registrationPassword) throw new Error('Add a registration email and password in Settings.');
    // The password goes only to the verified registration form in this tab, never to AI, logs or backups.
    return sendForm(message.tabId,'registration',{revision:message.revision,url:message.page,email,value:local.registrationPassword});
  },
  'data:clear':async message=>{
    if(message.confirm!=='DELETE') throw new Error('Type DELETE to remove local MeshJob data.');
    await setMode('Finished');
    stopMail();
    await Promise.all([chrome.storage.local.remove(['claudeKey','registrationEmail','registrationPassword']),disconnectMail(false)]);
    await db.transaction('rw',db.tables,async()=>{
      await Promise.all(db.tables.filter(table=>table!==db.settings).map(table=>table.clear()));
      const before=await settings();
      await db.settings.put({id:'settings',mode:'Finished',generation:before.generation+1});
    });
    return true;
  }
};
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || !message?.type) return false;
  const fromUI = sender.url?.startsWith(base) && /\/(?:dashboard|panel)\.html(?:[?#]|$)/.test(sender.url);
  const operation=fromUI ? Object.hasOwn(handlers,message.type)&&handlers[message.type] : ['page:receipt','page:intent'].includes(message.type) ? value=>pageMessage(value,sender) : null;
  if(!operation) return false;
  void Promise.resolve().then(()=>operation(message)).then(value=>respond({ok:true,value}),error=>respond({ok:false,error:String(error.message??error).slice(0,600)}));
  return true;
});
