import { db, guarded, settings, updateSettings } from './db.js';
import { CATALOG } from './catalog.js';
import { canonicalUrl, httpUrl, list, nowISO, publicUrl, sponsorshipEvidence, uid } from './domain.js';
import { disconnectMail, getMailToken } from './mail.js';
import { portableConfig } from './portability.js';
import { candidateDetails } from './discovery.js';
import { evaluateCandidate, relevantFacts } from './intelligence.js';
import { collect, detectSource, jsonPostings, postingIdentity } from './sources.js';
import {
  addSources, arm, cancelOperation, claudeFor, notifyUrgent, pattern, previewSource, recordManualRun, registerSchedules, runSource,
  scopedFetch, setMode, stopMail, stopSource, testNotification, tick
} from './service.js';
import { actionState, appendEvent, expiryEvidence, saveApplication } from './tracker.js';

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
chrome.action.onClicked.addListener(tab=>{
  const url=httpUrl(tab.url);
  if (url && (/(?:^|\.)(?:greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|myworkdaysite\.com|linkedin\.com)$/.test(url.hostname) ||
    /\/(?:jobs?|careers?|apply|application|positions?)(?:[/?#]|$)/i.test(url.pathname))) {
    void chrome.sidePanel.open({tabId:tab.id}).catch(()=>dashboard());
  } else void dashboard();
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
  if (type!=='advance') await sameTab(tabId,type==='inspect'?tab.url:data.url);
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
  const state=await tabState(sender.tab.id);
  if (!state||state.expiresAt<=Date.now()||state.origin!==httpUrl(sender.url)?.origin) return null;
  if (message.type==='page:intent') {
    const app=await db.applications.get(state.appId);
    if (!app || (postingIdentity(state.url)?.key && postingIdentity(state.url)?.key !== postingIdentity(sender.url)?.key) ||
      canonicalUrl(state.url)!==canonicalUrl(sender.url)&&!postingIdentity(sender.url)) return null;
    const at=nowISO();
    await db.runtime.update(state.id,{intention:at});
    return appendEvent({id:'submit-attempt:'+state.appId,applicationId:state.appId,kind:'needs-check',at,url:canonicalUrl(sender.url)});
  }
  if (message.type==='page:receipt' && state.intention && Date.now()-Date.parse(state.intention)<30*60_000) {
    const evidence=expiryEvidence(message.proof,state,sender.url);
    if (!evidence || !postingIdentity(state.url)) return null;
    return appendEvent({id:'ats-receipt:'+state.appId,applicationId:state.appId,kind:'ats-receipt',stage:'Applied',at:nowISO(),...evidence});
  }
  return null;
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
  if (original && current && original.key!==current.key) throw new Error('The job identity changed.');
  return state;
}
async function materialRefs(ids,result) {
  const entries=await db.materials.bulkGet([ids.resume||'',ids.cover||'']);
  const reference = material=>material ? {id:material.id,name:material.name,revision:material.revision,hash:material.hash} : null;
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
  const preferenceChanged=cleaned.preferences && JSON.stringify(before.preferences)!==JSON.stringify(conf.preferences);
  const matchingChanged=preferenceChanged || cleaned.profile&&JSON.stringify(before.profile)!==JSON.stringify(conf.profile) || cleaned.model&&conf.model!==before.model;
  if (matchingChanged) {
    await db.transaction('rw',db.jobs,db.sources,async()=>{
      await db.jobs.filter(job=>!!job.match||!!job.matchKey).modify(job=>{delete job.match;delete job.matchKey;});
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
  'secret:password':async message=>{
    const value=String(message.value??'');
    if(value.length>256) throw new Error('The password is too long.');
    if(value&&message.persist&&!message.consent) throw new Error('Confirm the local plaintext option explicitly.');
    await chrome.storage.session.remove('conveniencePassword');
    await chrome.storage.local.remove('conveniencePassword');
    if(value) {
      await chrome.storage[message.persist?'local':'session'].set({conveniencePassword:value});
    }
    return {configured:!!value,persistent:!!value&&!!message.persist};
  },
  'integrations:status':async ()=>{
    const local=await chrome.storage.local.get(['claudeKey','conveniencePassword']);
    const session=await chrome.storage.session.get('conveniencePassword');
    return {claude:!!local.claudeKey,password:!!(local.conveniencePassword||session.conveniencePassword),persistent:!!local.conveniencePassword,
      gmailConfigured:!!chrome.runtime.getManifest().oauth2};
  },
  'gmail:connect':async message=>{
    await getMailToken({interactive:true,modify:!!message.modify});
    const previous=await settings();
    if(!previous.gmail) await db.runtime.delete('gmail-cursor');
    await updateSettings({gmail:true,markRead:!!message.modify});
    void tick().catch(()=>{});
    return true;
  },
  'gmail:readonly':async ()=>{
    stopMail();await updateSettings({markRead:false});return true;
  },
  'gmail:disconnect':async message=>{
    stopMail();
    const previous=await settings();
    try { await disconnectMail(!!message.revoke); }
    finally {
      await updateSettings({gmail:false,markRead:false});
      await db.transaction('rw',db.runtime,db.events,async()=>{
        await db.runtime.bulkDelete(['gmail-cursor','health:gmail']);
        await db.events.filter(event=>event.pendingRead).modify({pendingRead:false});
      });
    }
    return previous.gmail;
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
    const inspection=await sendForm(message.tabId,'inspect',{},true);
    const local=await tabState(message.tabId);
    if(local && local.expiresAt>Date.now() && local.origin===httpUrl(inspection.page)?.origin) {
      const identity=postingIdentity(inspection.page), prior=postingIdentity(local.url);
      if(!identity||!prior||identity.key===prior.key) inspection.sessionAppId=local.appId;
    }
    return inspection;
  },
  'form:prepare':async message=>{
    await sameTab(message.tabId,message.inspection.page);
    const result=await saveApplication(message.job,{stage:'Preparing',jobId:message.jobId,existingId:message.existingId});
    await setTabState(message.tabId,result.application,message.inspection);
    return result;
  },
  'form:fill':async message=>{
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const result=await sendForm(message.tabId,'fill',{revision:message.revision,url:message.page,plan:message.plan});
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
    if(!provider) throw new Error('Connect Claude in Profile.');
    const fields=message.fields.filter(field=>!field.critical&&!field.consent&&!['password','file','radio','checkbox','skill-picker'].includes(field.type))
      .slice(0,25).map(({id,label,options,type})=>({id,label:String(label).slice(0,240),type,options:options.slice(0,12)}));
    if(!fields.length) return [];
    return message.draft?provider.draftAnswers({fields:fields.filter(field=>field.type==='textarea'),facts:relevantFacts(config.profile),role:app.title}):
      provider.mapFields({fields,keys:message.keys});
  },
  'form:rows':async message=>{
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const config=await settings();
    return sendForm(message.tabId,'rows',{revision:message.revision,url:message.page,
      counts:{experience:config.profile.experience?.length??0,education:config.profile.education?.length??0}});
  },
  'form:advance':async message=>{
    const app=await db.applications.get(message.applicationId);
    if(!app||!(await settings()).advance) throw new Error('Enable reviewed Workday navigation in Profile.');
    await formContext(message,app);
    const next=await sendForm(message.tabId,'advance',{revision:message.revision,url:message.page});
    await db.runtime.update('form-tab:'+message.tabId,{checkpoint:next.step});
    return next;
  },
  'form:stop':message=>sendForm(message.tabId,'cancel'),
  'form:password':async message=>{
    const state=await sameTab(message.tabId,message.page);
    const identity=postingIdentity(state.url);
    if(!identity||httpUrl(state.url)?.protocol!=='https:') throw new Error('This tab is not a verified ATS registration flow.');
    const app=await db.applications.get(message.applicationId);
    if(!app) throw new Error('Prepare this application first.');
    await formContext(message,app);
    const session=await chrome.storage.session.get('conveniencePassword');
    const local=session.conveniencePassword?{}:await chrome.storage.local.get('conveniencePassword');
    const value=session.conveniencePassword||local.conveniencePassword;
    if(!value) throw new Error('Use Chrome Password Manager or set a temporary password in Profile.');
    return sendForm(message.tabId,'password',{revision:message.revision,url:message.page,value});
  },
  'data:clear':async message=>{
    if(message.confirm!=='DELETE') throw new Error('Type DELETE to remove local MeshJob data.');
    await setMode('Finished');
    stopMail();
    await Promise.all([chrome.storage.local.remove(['claudeKey','conveniencePassword']),chrome.storage.session.remove('conveniencePassword'),disconnectMail(false)]);
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
