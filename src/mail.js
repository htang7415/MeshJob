import { claim, db, guarded, release, settings } from './db.js';
import { hash, httpUrl, normalized, nowISO, trim } from './domain.js';
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
  const provider = mail.provider ?? 'gmail';
  const stages = {confirmation:'Applied',rejection:'Rejected',assessment:'OA',interview:'Interview',offer:'Offer'};
  const trusted = !!app && classification.confidence === 'High';
  return {
    id:provider+':'+mail.id,messageId:mail.id,threadId:mail.threadId,applicationId:trusted ? app.id : undefined,at:mail.at,
    kind:trusted && classification.category === 'confirmation' ? 'email-confirmation' : 'email',
    stage:trusted ? stages[classification.category] : undefined,category:classification.category,
    subject:mail.subject,excerpt:mail.snippet.slice(0,360),url:mail.link ?? (provider==='gmail' ? mailLink(mail.id,account) : undefined),
    urgent:classification.urgent,review:!trusted && (classification.urgent || classification.category !== 'unknown' || provider==='manual'),
    deadline:classification.urgent ? deadlineOf(mail.subject+' '+mail.snippet) : null
  };
}

// Each user connects a mailbox with their own OAuth app (spec 7): no shared client, no user cap, any account.
// chrome.identity.launchWebAuthFlow returns an access token to https://<extension id>.chromiumapp.org/.
export const MAIL_PROVIDERS = {
  gmail:{label:'Gmail',authorize:'https://accounts.google.com/o/oauth2/v2/auth',scope:MAIL_SCOPE,required:[MAIL_SCOPE],
    origins:['https://gmail.googleapis.com/*','https://oauth2.googleapis.com/*'],client:/^[\w-]{6,120}\.apps\.googleusercontent\.com$/,extra:{include_granted_scopes:'true'}},
  outlook:{label:'Outlook',authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scope:'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read',required:['Mail.Read'],
    origins:['https://graph.microsoft.com/*'],client:/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,extra:{response_mode:'fragment'}}
};
export const CLIENT_ID = MAIL_PROVIDERS.gmail.client;
const providerOf = name => MAIL_PROVIDERS[name] ?? MAIL_PROVIDERS.gmail;
export async function mailClient(provider) {
  const key = provider+'ClientId';
  const value = (await chrome.storage.local.get(key))[key];
  return providerOf(provider).client.test(value ?? '') ? value : '';
}
export const redirectUri = (id = chrome.runtime.id) => 'https://' + id + '.chromiumapp.org/';
export function authUrl({provider='gmail',clientId,redirect,interactive,account,state}) {
  const spec = providerOf(provider);
  const url = new URL(spec.authorize);
  for (const [key,value] of Object.entries({client_id:clientId,redirect_uri:redirect,response_type:'token',scope:spec.scope,
    state,prompt:interactive?'select_account':'none',...spec.extra,...(account?{login_hint:account}:{})})) url.searchParams.set(key,value);
  return url.href;
}
export function parseRedirect(responseUrl,state,redirect,provider='gmail') {
  if (typeof responseUrl !== 'string' || !responseUrl.startsWith(redirect)) throw new Error('The sign-in returned an unexpected response.');
  const values = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  if (values.get('error')) throw new Error(values.get('error')==='access_denied'?'Mail access was not granted.':'Mail sign-in needs you to reconnect.');
  if (values.get('state') !== state) throw new Error('Mail sign-in state did not match.');
  const token = values.get('access_token'), seconds = Number(values.get('expires_in'));
  const scopes = String(values.get('scope') ?? '').split(' ');
  const granted = providerOf(provider).required.every(need=>scopes.some(scope=>scope===need||scope.endsWith('/'+need)));
  if (!token || !Number.isFinite(seconds) || !granted) throw new Error('Mail read access was not granted.');
  return {token,expiresAt:Date.now()+seconds*1000};
}
export async function getMailToken({provider='gmail',interactive=false}={}) {
  const clientId = await mailClient(provider);
  if (!clientId) throw new Error('Set up your '+providerOf(provider).label+' app in Settings first.');
  const granted = await chrome.permissions.contains({permissions:['identity'],origins:providerOf(provider).origins});
  if (!granted) throw new Error('Mail permissions are missing. Connect your email again in Settings.');
  const {mailToken} = await chrome.storage.session.get('mailToken');
  if (!interactive && mailToken?.clientId === clientId && mailToken.expiresAt > Date.now()+60_000) return mailToken.token;
  const {mailAccount} = await chrome.storage.local.get('mailAccount');
  if (!interactive && !mailAccount) throw new Error('Reconnect your email in Settings.');
  const redirect = redirectUri(), state = crypto.randomUUID();
  let response;
  try {
    response = await chrome.identity.launchWebAuthFlow({url:authUrl({provider,clientId,redirect,interactive,account:interactive?'':mailAccount,state}),interactive,
      ...(interactive ? {} : {abortOnLoadForNonInteractive:false,timeoutMsForNonInteractive:10_000})});
  } catch {
    throw new Error(interactive ? 'Sign-in was cancelled.' : 'Your mail provider needs you to sign in again. Reconnect in Settings.');
  }
  const result = parseRedirect(response,state,redirect,provider);
  await chrome.storage.session.set({mailToken:{...result,clientId}});
  return result.token;
}
export async function disconnectMail(revoke=false,provider='gmail') {
  const {mailToken} = await chrome.storage.session.get('mailToken');
  if (revoke && provider==='gmail' && mailToken?.token) {
    const response = await fetch('https://oauth2.googleapis.com/revoke',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({token:mailToken.token}),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Google rejected token revocation. Remove access in your Google Account.');
  }
  await chrome.storage.session.remove('mailToken');
  await chrome.storage.local.remove('mailAccount');
}

class MailError extends Error {
  constructor(status) { super('Mail server returned HTTP '+status); this.status=status; }
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

// Shared by every mailbox and by manually added mail: classify, link conservatively, record minimal evidence.
async function recordMail(message,{apps,ai,account,generation}) {
  let classification = classifyMail(message);
  if (ai && classification.category === 'unknown' && classification.urgent) {
    try {
      const extra = await ai.classifyEmail({subject:message.subject,snippet:message.snippet.slice(0,460)});
      if (extra.urgent && !['confirmation','rejection','update'].includes(extra.category)) classification = {...classification,category:extra.category};
    } catch { /* Retain the local urgent decision. */ }
  }
  if (classification.category === 'unknown' && !classification.urgent && message.provider!=='manual') return null;
  const thread = await db.events.where('threadId').equals(message.threadId).toArray();
  const app = linkMail(message,apps,thread);
  const event = mailEvent(message,classification,app,account);
  const result = await appendEvent(event,generation);
  return result?.event ? {event,application:result.application??null} : null;
}
const mailSince = config => Number.isFinite(Date.parse(config.gmailSince)) ? Date.parse(config.gmailSince) : Date.now()-14*86400000;

export async function syncMail(options) {
  return options.config.mailProvider==='outlook' ? syncOutlook(options) : syncGmail(options);
}
async function syncGmail({config,generation,signal,notify,api,ai}) {
  if (!config.gmail) throw new Error('Connect your email in Settings.');
  const lease = await claim('run:gmail','lease',4*60_000,generation);
  if (!lease) return;
  let accepted = 0, urgent = 0;
  try {
    const token = api ? null : await getMailToken({provider:'gmail'});
    const request = api ?? gmailHttp(token,signal);
    async function check() {
      signal?.throwIfAborted();
      const current = await settings();
      if (!current.gmail || (generation != null && (current.generation !== generation || current.mode !== 'Active'))) throw new Error('Gmail sync cancelled.');
      return current;
    }
    // Only mail received after the mailbox was connected is read (spec 7); older mail is never fetched.
    const since = mailSince(config);
    async function processIds(ids) {
      const apps = await db.applications.toArray();
      for (const id of [...new Set(ids)].filter(value=>MAIL_ID.test(value ?? ''))) {
        await check();
        if (await db.events.where('messageId').equals(id).first()) continue;
        let message;
        try { message = normalizeMail(await request('/messages/'+encodeURIComponent(id),{query:{format:'full',fields:'id,threadId,internalDate,payload/headers,snippet,labelIds'}})); }
        catch (error) { if (error.status===404) continue; throw error; }
        if (message.excluded || Date.parse(message.at) < since) continue;
        const recorded = await recordMail(message,{apps,ai,account:state?.account,generation});
        if (recorded) {
          accepted++;
          if (recorded.event.urgent) urgent++;
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
      const start = Math.max(since, Date.now()-14*86400000);
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

// Outlook, Hotmail and Microsoft 365 through Microsoft Graph (read-only).
export function graphHttp(token,signal,fetcher=fetch) {
  return async path => {
    const url = path.startsWith('https://graph.microsoft.com/') ? path : 'https://graph.microsoft.com/v1.0'+path;
    if (!url.startsWith('https://graph.microsoft.com/v1.0/')) throw new Error('Unexpected Microsoft Graph address.');
    const timeout = AbortSignal.timeout(12000);
    const response = await fetcher(url,{headers:{Authorization:'Bearer '+token},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
      signal:signal?AbortSignal.any([signal,timeout]):timeout});
    if (!response.ok) throw new MailError(response.status);
    return response.json();
  };
}
const shortId = async value => 'o'+(await hash(String(value))).slice(0,40);
export async function outlookMessage(row) {
  if (typeof row?.id !== 'string' || !row.receivedDateTime) throw new Error('Invalid Outlook message.');
  const sender = row.from?.emailAddress ?? {};
  return {provider:'outlook',id:await shortId(row.id),threadId:await shortId(row.conversationId ?? row.id),at:new Date(row.receivedDateTime).toISOString(),
    from:trim([sender.name,sender.address&&'<'+sender.address+'>'].filter(Boolean).join(' ')),subject:trim(row.subject).slice(0,250),
    snippet:trim(row.bodyPreview).slice(0,800),unread:row.isRead===false,link:httpUrl(row.webLink)?.protocol==='https:'?row.webLink:undefined};
}
async function syncOutlook({config,generation,signal,notify,api,ai}) {
  if (!config.gmail) throw new Error('Connect your email in Settings.');
  const lease = await claim('run:gmail','lease',4*60_000,generation);
  if (!lease) return;
  let accepted = 0, urgent = 0, next = null;
  try {
    const request = api ?? graphHttp(await getMailToken({provider:'outlook'}),signal);
    const check = async () => {
      signal?.throwIfAborted();
      const current = await settings();
      if (!current.gmail || (generation != null && (current.generation !== generation || current.mode !== 'Active'))) throw new Error('Mail sync cancelled.');
    };
    const state = (await db.runtime.get('outlook-cursor')) ?? {};
    const since = new Date(Math.max(mailSince(config),Date.parse(state.after ?? '') || 0)).toISOString();
    const select = 'id,conversationId,subject,from,bodyPreview,receivedDateTime,isRead,webLink';
    next = state.nextLink ?? '/me/mailFolders/inbox/messages?$filter='+encodeURIComponent('receivedDateTime ge '+since)+
      '&$orderby=receivedDateTime asc&$top=50&$select='+select;
    let after = state.after;
    for (let page=0; page<3 && next; page++) {
      await check();
      const batch = await request(next);
      const apps = await db.applications.toArray();
      for (const row of batch.value ?? []) {
        await check();
        const message = await outlookMessage(row);
        after = message.at;
        if (Date.parse(message.at) < mailSince(config) || await db.events.where('messageId').equals(message.id).first()) continue;
        const recorded = await recordMail(message,{apps,ai,generation});
        if (recorded) { accepted++; if (recorded.event.urgent) urgent++; }
      }
      next = typeof batch['@odata.nextLink'] === 'string' ? batch['@odata.nextLink'] : null;
      await guarded(generation,[db.runtime],()=>db.runtime.put({id:'outlook-cursor',kind:'gmail',after,nextLink:next}));
    }
    await check();
    if (notify) await notify(generation);
    return {accepted,urgent,hasMore:!!next};
  } finally { await release('run:gmail',lease); }
}

// Any other mailbox: paste a message or drop a saved .eml file (spec 7).
function decodePart(body,encoding) {
  if (/base64/i.test(encoding ?? '')) {
    try { return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g,'')),c=>c.charCodeAt(0))); } catch { return body; }
  }
  if (/quoted-printable/i.test(encoding ?? '')) {
    const bytes = body.replace(/=\r?\n/g,'').replace(/=([\dA-F]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
    try { return new TextDecoder().decode(Uint8Array.from(bytes,c=>c.charCodeAt(0))); } catch { return bytes; }
  }
  return body;
}
export function parseMailText(raw) {
  const text = String(raw ?? '').replace(/\r\n/g,'\n').slice(0,2_000_000);
  const split = text.indexOf('\n\n');
  const headBlock = split > 0 ? text.slice(0,split) : '';
  const headers = {};
  if (/^(?:[\w-]+:.*(?:\n[ \t].*)*\n?)+$/.test(headBlock) && /^(?:subject|from|date|received|message-id|mime-version):/im.test(headBlock)) {
    for (const [,name,value] of headBlock.replace(/\n[ \t]+/g,' ').matchAll(/^([\w-]+):\s*(.*)$/gm)) headers[name.toLowerCase()] ??= value;
  }
  let body = Object.keys(headers).length ? text.slice(split+2) : text;
  const boundary = /boundary="?([^";]+)"?/i.exec(headers['content-type'] ?? '')?.[1];
  if (boundary) {
    const part = body.split('--'+boundary).find(chunk=>/content-type:\s*text\/plain/i.test(chunk)) ?? body.split('--'+boundary).find(chunk=>/content-type:\s*text\/html/i.test(chunk));
    if (part) {
      const at = part.replace(/\r\n/g,'\n').indexOf('\n\n');
      const encoding = /content-transfer-encoding:\s*([\w-]+)/i.exec(part.slice(0,at))?.[1];
      body = decodePart(part.slice(at+2),encoding);
    }
  } else body = decodePart(body,headers['content-transfer-encoding']);
  body = body.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ');
  const lines = body.split('\n').map(trim).filter(Boolean);
  const subject = trim(headers.subject ?? lines.shift() ?? '').replace(/=\?[^?]+\?[BQ]\?[^?]*\?=/gi,'').slice(0,250);
  const date = Date.parse(headers.date ?? '');
  return {subject,from:trim(headers.from ?? '').slice(0,250),at:Number.isFinite(date)?new Date(date).toISOString():new Date().toISOString(),
    snippet:trim(lines.join(' ')).slice(0,800)};
}
export async function addMail(raw,{ai}={}) {
  const parsed = parseMailText(raw);
  if (!parsed.subject && !parsed.snippet) throw new Error('Paste the email subject and text, or choose a saved .eml file.');
  const id = 'm'+(await hash(parsed.subject+'\n'+parsed.from+'\n'+parsed.snippet)).slice(0,40);
  if (await db.events.where('messageId').equals(id).first()) return {duplicate:true};
  const message = {...parsed,provider:'manual',id,threadId:id};
  const recorded = await recordMail(message,{apps:await db.applications.toArray(),ai});
  return {event:recorded?.event??null,application:recorded?.application??null};
}
