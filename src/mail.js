import { claim, db, guarded, release, settings } from './db.js';
import { httpUrl, normalized, nowISO, trim } from './domain.js';
import { appendEvent } from './tracker.js';

export const MAIL_ORIGINS = ['https://gmail.googleapis.com/*','https://oauth2.googleapis.com/*'];
// Read-only: MeshJob never changes the mailbox (spec 7).
export const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAIL_ID = /^[a-z\d_-]{1,150}$/i;
const allowed = {
  assessment:[/\b(?:online|technical|coding|skills|take.home|pre.employment|timed) (?:assessment|test|challenge)\b/,/\b(?:hackerrank|codesignal|codility|testgorilla|criteria corp)\b/,/\bassessment (?:invitation|invite|due|deadline|link)\b/,/\b(?:coding exercise|assessment exercise|technical screen.{0,90}complete the exercise)\b/],
  interview:[/\b(?:invitation to interview|interview slots|speak with the hiring manager)\b/,/\b(?:schedule|book|arrange|confirm|reschedule) (?:your |an? |the )?(?:interview|screen|call|meeting)\b/,/\b(?:interview|phone screen|panel interview) (?:invite|invitation|availability|scheduling|confirmation|with|for)\b/,/\b(?:invite|invited|like|love|pleased) (?:you |to )*(?:to |for )?(?:an? )?interview\b/],
  offer:[/\b(?:the role is yours|approved your appointment)\b/,/\b(?:offer letter|job offer|offer of employment|employment offer|extend (?:an |you an )?offer|your offer from)\b/],
  rejection:[/\b(?:chose|selected|hired|appointed) another (?:applicant|candidate)\b/,/\b(?:unfortunately|regret to inform)\b.{0,130}\b(?:move forward|proceed|selected|continue|offer)\b/,/\b(?:not (?:be )?(?:moving|move) forward|other candidates|unable to proceed|not selected|position (?:has been|was) filled|application (?:was |has been )?unsuccessful)\b/],
  confirmation:[/\b(?:application receipt|application is in our system)\b/,/\b(?:application received|application (?:has been |was )?(?:successfully )?submitted|received your application|thank you for (?:your application|applying)|thanks for applying|application confirmation)\b/],
  update:[/\b(?:review in progress|moved to (?:departmental|initial|committee) review)\b/,/\b(?:application status|under review|recruiting update|application update|recruitment update|still considering)\b/]
};
const recruitingContext = /\b(?:application|candidate|position|hiring|recruit(?:er|ing|ment)?|interview|assessment|talent|offer|role|job|calendar invitation|applicant|people team|scheduling desk|candidate portal|hiring manager)\b/;
const requested = /\b(?:action required|next steps?|deadline|due(?: date| by)?|please (?:reply|respond|complete|confirm|send|provide|submit|review|select|book|choose|share|let us know)|your availability|availability for|respond by|awaiting your|by end of day|time.sensitive|would you be available|would (?:you |\w+ at \w+ )?(?:share|send|be possible)|can you (?:email|send|share)|new task|your response by|waiting for (?:your|the corrected))\b/;

export function classifyMail(mail) {
  const subject = normalized(mail.subject);
  const copy = normalized(mail.snippet);
  const subjectAndCopy = subject+' '+copy;
  const contextual = recruitingContext.test(subjectAndCopy) || /recruit|talent|hiring|assessment|scheduling/i.test(mail.from ?? '');
  const action = requested.test(subjectAndCopy);
  const scheduling = /\b(?:select|choose) (?:a|an) (?:time|slot)|\b(?:schedule (?:changed|updated)|questionnaire is ready|calendar invitation|response by)\b/.test(subjectAndCopy);
  const hits = name => allowed[name].some(pattern=>pattern.test(subjectAndCopy));
  const rejection = hits('rejection');
  const activeInvite = ['assessment','interview','offer'].filter(hits);
  if (activeInvite.length && (!rejection || action)) {
    return {category:activeInvite.length === 1 ? activeInvite[0] : 'unknown',urgent:true,confidence:activeInvite.length === 1 ? 'High' : 'Low'};
  }
  if (contextual && (action || scheduling) || /\b(?:need details on your profile|next step from the coordinator)\b/.test(subject) && action) return {category:'follow-up',urgent:true,confidence:'Medium'};
  if (rejection) return {category:'rejection',urgent:false,confidence:'High'};
  if (hits('confirmation')) return {category:'confirmation',urgent:false,confidence:'High'};
  if (hits('update')) return {category:'update',urgent:false,confidence:'High'};
  if (contextual && /\b(?:interview|assessment|offer|invitation|follow up|followup|applicant kit|scheduling)\b/.test(subject)) return {category:'unknown',urgent:true,confidence:'Low'};
  return {category:'unknown',urgent:false,confidence:'Low'};
}

function hasPhrase(haystack, needle) {
  const fragment = normalized(needle);
  return fragment.length >= 3 && (' '+haystack+' ').includes(' '+fragment+' ');
}

export function linkMail(mail,apps,threads = []) {
  const haystack = normalized(mail.subject+' '+mail.snippet);
  const before = Date.parse(mail.at);
  const alias = String(mail.from ?? '').toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/)?.[1];
  const tied = new Set(threads.filter(event=>event.threadId===mail.threadId && event.applicationId).map(event=>event.applicationId));
  const candidates = apps.filter(app=>Date.parse(app.createdAt) <= before + 5*86400000).map(app=>{
    const req = normalized(app.requisition);
    const byReq = req.length >= 4 && /\d/.test(req) && hasPhrase(haystack,req);
    const byTitle = hasPhrase(haystack,app.title);
    const company = normalized(app.company);
    const ats = /(?:greenhouse|ashbyhq|lever|myworkdayjobs|workday)\./.test(httpUrl(app.url)?.hostname ?? '');
    const appHost = httpUrl(app.url)?.hostname;
    const byDomain = !ats && !!alias && appHost && (appHost === alias || appHost.endsWith('.'+alias) || alias.endsWith('.'+appHost));
    const byCompany = hasPhrase(haystack,company) || byDomain ||
      (company.length>=5 && alias?.split('.')[0] === company.replaceAll(' ',''));
    const byThread = tied.has(app.id);
    return {app,score:byReq ? (byCompany || byTitle || byThread ? 4 : 2) : byTitle&&byCompany ? 3 : byThread ? 3 : 0};
  }).filter(entry=>entry.score>=3).sort((a,b)=>b.score-a.score);
  if (!candidates.length || candidates[0].score === candidates[1]?.score) return null;
  return candidates[0].app;
}

function deadlineOf(copy) {
  const match = /\b(?:by|before|due|deadline(?: is|:)?)\s+(\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d|\s+(?:UTC|GMT|PST|PDT|MST|MDT|CST|CDT|EST|EDT))?)?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? \d{1,2}(?:,? \d{4})?(?:\s+(?:at )?\d{1,2}(?::\d\d)?\s*(?:am|pm)?\s*(?:UTC|GMT|PST|PDT|MST|MDT|CST|CDT|EST|EDT))?)/i.exec(copy);
  if (!match) return null;
  return { text:match[1],timezone:match[1].match(/(?:Z|[+-]\d\d:\d\d|UTC|GMT|[PMCE][SD]T)$/)?.[0] ?? null };
}
export const mailLink=(id,account)=>'https://mail.google.com/mail/'+(account?'?authuser='+encodeURIComponent(account):'u/0/')+'#all/'+encodeURIComponent(id);
export function mailEvent(mail,classification,app,account) {
  const stages = {confirmation:'Applied',rejection:'Rejected',assessment:'OA',interview:'Interview',offer:'Offer'};
  const trusted = !!app && classification.confidence === 'High';
  return {
    id:'gmail:'+mail.id,messageId:mail.id,threadId:mail.threadId,applicationId:trusted ? app.id : undefined,at:mail.at,
    kind:trusted && classification.category === 'confirmation' ? 'email-confirmation' : 'email',
    stage:trusted ? stages[classification.category] : undefined,category:classification.category,
    subject:mail.subject,excerpt:mail.snippet.slice(0,360),url:mailLink(mail.id,account),
    urgent:classification.urgent,review:!trusted && (classification.urgent || classification.category !== 'unknown'),
    deadline:classification.urgent ? deadlineOf(mail.subject+' '+mail.snippet) : null
  };
}

function oauthConfigured() {
  return !!chrome.runtime.getManifest().oauth2?.client_id;
}
export async function getMailToken({interactive=false}={}) {
  if (!oauthConfigured()) throw new Error('This build has no Gmail OAuth client. Follow the user-owned OAuth setup in the README.');
  const granted = await chrome.permissions.contains({permissions:['identity'],origins:MAIL_ORIGINS});
  if (!granted) throw new Error('Gmail permissions are missing.');
  const result = await chrome.identity.getAuthToken({interactive,scopes:[MAIL_SCOPE],enableGranularPermissions:true});
  if (!result.token || (result.grantedScopes && !result.grantedScopes.includes(MAIL_SCOPE))) throw new Error('Gmail consent was not granted.');
  return result.token;
}
export async function disconnectMail(revoke=false) {
  if (oauthConfigured() && revoke) {
    let token;
    try { token = await getMailToken(); } catch { /* Consent can already be absent. */ }
    if (token) {
      const response = await fetch('https://oauth2.googleapis.com/revoke',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({token}),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error('Google rejected token revocation. Remove access in your Google Account.');
    }
  }
  if (await chrome.permissions.contains({permissions:['identity']})) await chrome.identity.clearAllCachedAuthTokens();
}

class MailError extends Error {
  constructor(status) { super('Gmail returned HTTP '+status); this.status=status; }
}
export function gmailHttp(token,signal,fetcher=fetch) {
  return async (path,{query={},body}={}) => {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me'+path);
    for (const [key,value] of Object.entries(query)) for (const item of [value].flat()) if (item != null) url.searchParams.append(key,item);
    const timeout = AbortSignal.timeout(12000);
    const response = await fetcher(url.href,{
      headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
      method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
      signal:signal?AbortSignal.any([signal,timeout]):timeout
    });
    if (!response.ok) throw new MailError(response.status);
    return response.json();
  };
}

const SENDERS = ['greenhouse.io','greenhouse-mail.io','ashbyhq.com','lever.co','hire.lever.co','myworkday.com','workday.com','smartrecruiters.com','workablemail.com',
  'icims.com','jobvite.com','hackerrank.com','codesignal.com','codility.com','karat.io','goodtime.io','calendly.com','gem.com','modernloop.io'];
const ALERTS = ['jobalerts-noreply@linkedin.com','jobs-listings@linkedin.com','alert@indeed.com','noreply@glassdoor.com','jobs@ziprecruiter.com'];
// Built from ATS senders, tracked employers and recruiting words; job-alert newsletters and promotions are excluded.
export function recruitingQuery(companies=[]) {
  const names=[...new Set(companies.map(name=>trim(name).replace(/["{}()]/g,'')).filter(name=>name.length>=3))].slice(0,25).map(name=>'"'+name+'"');
  const words=['application','applicant','interview','assessment','"offer letter"','"next steps"','recruiter','recruiting'];
  return '{'+[...SENDERS.map(domain=>'from:'+domain),...names,...words].join(' ')+'} -category:promotions '+ALERTS.map(from=>'-from:'+from).join(' ')+' -in:spam -in:trash';
}
const PAGE = 20;
const MAX_PAGES = 3;
function normalizeMail(message) {
  if (!MAIL_ID.test(message.id ?? '') || !MAIL_ID.test(message.threadId ?? '')) throw new Error('Invalid Gmail message identity.');
  const header = key => trim(message.payload?.headers?.find(entry=>entry.name.toLowerCase()===key)?.value);
  return {id:message.id,threadId:message.threadId,at:new Date(Number(message.internalDate)).toISOString(),
    from:header('from'),subject:header('subject').slice(0,250),snippet:trim(message.snippet).slice(0,800),
    unread:message.labelIds?.includes('UNREAD'),excluded:message.labelIds?.some(label=>['SPAM','TRASH','DRAFT','SENT'].includes(label))};
}
async function saveCursor(checkpoint,generation) {
  return guarded(generation,[db.runtime],()=>db.runtime.put({id:'gmail-cursor',kind:'gmail',...checkpoint}));
}

export async function syncMail({config,generation,signal,notify,api,ai}) {
  if (!config.gmail) throw new Error('Connect Gmail in Profile.');
  const lease = await claim('run:gmail','lease',4*60_000,generation);
  if (!lease) return;
  let accepted = 0, urgent = 0;
  try {
    const token = api ? null : await getMailToken();
    const request = api ?? gmailHttp(token,signal);
    async function check() {
      signal?.throwIfAborted();
      const current = await settings();
      if (!current.gmail || (generation != null && (current.generation !== generation || current.mode !== 'Active'))) throw new Error('Gmail sync cancelled.');
      return current;
    }
    async function processIds(ids) {
      const apps = await db.applications.toArray();
      for (const id of [...new Set(ids)].filter(value=>MAIL_ID.test(value ?? ''))) {
        await check();
        if (await db.events.where('messageId').equals(id).first()) continue;
        let message;
        try { message = normalizeMail(await request('/messages/'+encodeURIComponent(id),{query:{format:'full',fields:'id,threadId,internalDate,payload/headers,snippet,labelIds'}})); }
        catch (error) { if (error.status===404) continue; throw error; }
        if (message.excluded) continue;
        let classification = classifyMail(message);
        if (ai && classification.category === 'unknown' && classification.urgent) {
          try {
            const extra = await ai.classifyEmail({subject:message.subject,snippet:message.snippet.slice(0,460)});
            if (extra.urgent && !['confirmation','rejection','update'].includes(extra.category)) classification = {...classification,category:extra.category};
          } catch { /* Retain the local urgent decision. */ }
        }
        if (classification.category === 'unknown' && !classification.urgent) continue;
        const thread = await db.events.where('threadId').equals(message.threadId).toArray();
        const app = linkMail(message,apps,thread);
        const event = mailEvent(message,classification,app,state?.account);
        const result = await appendEvent(event,generation);
        if (result?.event) {
          accepted++;
          if (event.urgent) urgent++;
        }
      }
    }
    let state = await db.runtime.get('gmail-cursor');
    for (let page=0;page<MAX_PAGES;page++) {
      await check();
      if (!state?.base) {
        const profile=await request('/profile');
        state = {...state,base:profile.historyId,account:typeof profile.emailAddress==='string'?profile.emailAddress.slice(0,254):state?.account,recover:true,pageToken:null};
        if (!state.base) throw new Error('Gmail did not supply a history cursor.');
        await saveCursor(state,generation);
      }
      const start = Date.now()-14*86400000;
      if (state.recover) {
        const query = 'after:'+Math.floor(start/1000)+' '+recruitingQuery((await db.applications.toArray()).map(app=>app.company));
        const batch = await request('/messages',{query:{q:query,maxResults:PAGE,pageToken:state.pageToken}});
        await processIds((batch.messages ?? []).map(item=>item.id));
        state = {...state,pageToken:batch.nextPageToken ?? null,recover:!!batch.nextPageToken};
      } else {
        let batch;
        try { batch = await request('/history',{query:{startHistoryId:state.base,historyTypes:'messageAdded',maxResults:PAGE,pageToken:state.pageToken}}); }
        catch (error) {
          if (error.status !== 404) throw error;
          state = {...state,base:null,pageToken:null,recover:true};
          await saveCursor(state,generation);
          continue;
        }
        await processIds((batch.history ?? []).flatMap(item=>(item.messagesAdded ?? []).map(entry=>entry.message.id)));
        state = {...state,pageToken:batch.nextPageToken ?? null,base:batch.nextPageToken ? state.base : batch.historyId ?? state.base};
      }
      await saveCursor(state,generation);
      if (!state.pageToken) break;
    }
    await check();
    if (notify) await notify(generation);
    return {accepted,urgent,hasMore:!!state?.pageToken};
  } finally { await release('run:gmail',lease); }
}
