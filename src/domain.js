export const STAGES = ['Saved', 'Preparing', 'Applied', 'OA', 'Interview', 'Offer', 'Rejected', 'Withdrawn', 'Accepted'];
export const SLOTS = ['08:30', '10:30', '12:30', '14:30', '16:30', '18:30'];
export const PREFERENCES = {
  titles: [], aliases: [], seniority: [], employmentType: [], locations: [], workMode: [], freshnessHours: 24,
  sponsorship: 'Unspecified', minimumPay: null, currency: 'USD', period: 'year', industries: [], companies: [],
  skills: [], excludeCompanies: [], excludeTitles: [], strictUnknown: false
};
export const DEFAULTS = {
  mode: 'Active', generation: 0, onboarded: false, preferences: PREFERENCES, profile: {}, slots: SLOTS,
  searchesPerRound: 3, roundsPerDay: 6, budget: 10, dailyBudget: 2, runBudget: 0.15, autoMatch: true,
  model: 'claude-haiku-5-5', draftModel: 'claude-haiku-5-5', directAlerts: true, advance: false,
  gmail: false, markRead: false, gmailDays: 14, jdDays: 30, tombstoneDays: 180
};
const TRACKING = /^(utm_\w+|gh_src|lever-source|source|fbclid|gclid|ref_src)$/i;
const PRIVATE_QUERY = /^(?:access_token|id_token|refresh_token|sessionid|session_id|candidateId|applicationToken|authToken|token)$/i;
const MEANINGFUL_QUERY = ['gh_jid', 'jobId', 'job_id', 'requisitionId'];
const DENIED = /(^|\.)(linkedin\.com|jobright\.ai|simplify\.jobs|ycombinator\.com|workatastartup\.com|localhost|local|internal|test)$/i;

export const nowISO = () => new Date().toISOString();
export const trim = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const normalized = value => trim(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export const list = value => Array.isArray(value) ? value.map(trim).filter(Boolean) : String(value ?? '').split(/[,\n]/).map(trim).filter(Boolean);
export const validDate = value => !!value && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value));
export const exactDate = value => validDate(value) && /T\d{2}:\d{2}.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Date.parse(value) <= Date.now();
export const uid = () => crypto.randomUUID();
export async function hash(value) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('');
}

export function httpUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}
export function publicUrl(value) {
  const url = httpUrl(value);
  if (!url || url.protocol !== 'https:' || url.port || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.endsWith('.') || DENIED.test(url.hostname)) return null;
  return url;
}

export function canonicalUrl(value) {
  const url = httpUrl(value);
  if (!url) return '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (PRIVATE_QUERY.test(key) && !(key==='token' && /(?:^|\.)greenhouse\.io$/.test(url.hostname) && /^\d+$/.test(url.searchParams.get(key)))) url.searchParams.delete(key);
    else if (TRACKING.test(key) && !(key.toLowerCase() === 'source' && !/(greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com)$/.test(url.hostname))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
export function hasJobPath(value) {
  const url = httpUrl(value);
  return !!url && (url.pathname.split('/').filter(Boolean).length >= 2 || MEANINGFUL_QUERY.some(key => url.searchParams.has(key)));
}
export function freshness(job, hours = 24, at = Date.now()) {
  const floor = at - hours * 3_600_000;
  if (job.active && job.official && exactDate(job.postedAt)) return Date.parse(job.postedAt) >= floor ? 'verified' : 'older';
  if (job.active && !job.reopenedAt && job.lastAbsentAt && Date.parse(job.firstSeenAt) >= floor) return 'detected';
  return 'unknown';
}

const ALIASES = [
  ['ai infra','ai infrastructure','inference','ml systems','ml platform','machine learning infrastructure','model serving','model deployment','model runtime'],
  ['software engineer','swe','software developer','software development engineer','full stack engineer','backend engineer','frontend engineer','systems engineer','software engineering','programmer','application developer','sde'],
  ['ai engineer','mle','machine learning engineer','applied scientist','applied ai','ml engineer','research engineer'],
  ['fde','forward deployed engineer','solutions engineer'],
  ['registered nurse','rn','staff nurse','clinical nurse'],
  ['product designer','ux designer','ui designer','experience designer','interaction designer'],
  ['teacher','educator','instructor'],
  ['accountant','accounting','bookkeeper','controller','financial reporting'],
  ['sales representative','account executive','business development representative'],
  ['data analyst','business intelligence analyst','analytics analyst','insights analyst'],
  ['customer support','customer service','support specialist','customer experience','member services','client services','client care','customer care'],
  ['mechanic','maintenance technician','service technician'],
  ['speech language pathologist','slp','speech therapist','communication disorders','speech language clinical fellow'],
  ['landscape architect','landscape architecture','landscape designer','public realm design','public realm designer','site planning','park design']
];
const stop = new Set(['a','an','the','of','and','for','to','in','i','ii','iii','junior','senior','lead','staff','principal','entry','level','manager','associate','specialist','engineer','remote']);
const phrase = (text, word) => (' ' + text + ' ').includes(' ' + word + ' ');
const conflicts = (wanted, known) => wanted.length && known && !wanted.some(value => {
  const lhs = normalized(value);
  const rhs = normalized(known);
  return phrase(rhs, lhs) || phrase(lhs, rhs);
});
export function titleRelevant(title, preferences) {
  const wanted = preferences.titles.map(normalized).filter(Boolean);
  if (!wanted.length || !title) return true;
  const role = normalized(title);
  const expanded = new Set([...wanted, ...preferences.aliases.map(normalized)]);
  for (const group of ALIASES) if (group.some(alias => wanted.some(value => phrase(value, alias)))) group.forEach(value => expanded.add(value));
  if ([...expanded].some(value => value && (phrase(role, value) || phrase(value, role)))) return true;
  const words = role.split(' ').filter(word => word.length > 1 && !stop.has(word));
  const tokens = new Set([...expanded].flatMap(value => value.split(' ')).filter(word => word.length > 1 && !stop.has(word)));
  return words.length <= 1 || words.some(word => tokens.has(word));
}

export function sponsorshipEvidence(text, url, userEvidence = []) {
  const evidence = [];
  for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+|\n/)) {
    const line = trim(sentence);
    const conditional = /\b(?:only if|unless|except|certain roles|some positions|in certain|depending on|case.by.case|where eligible|ineligible if)\b/i.test(line);
    if (!line || line.length > 700) continue;
    if (!conditional && /\b(?:no|unable to (?:provide |offer )?|cannot (?:provide |offer )?|will not (?:provide |offer )?|does not (?:provide |offer )?)\s*(?:(?:employment|immigration|visa|work)\s+)?sponsor(?:ship)?\b|\bsponsorship (?:is |will )?not (?:be )?(?:available|provided|offered)\b/i.test(line)) evidence.push({ status:'Not Supported', scope:'visa sponsorship', text:line, url });
    else if (!conditional && /\b(?:we (?:will|do|can|offer|provide) (?:offer |provide )?(?:(?:employment|immigration|visa|work)\s+)?sponsor(?:ship)?\b|(?:visa )?sponsorship is (?:available|provided|offered) for this (?:role|position))\b/i.test(line) && !/\b(?:may|case.by.case|not|depending|if eligible)\b/i.test(line)) evidence.push({ status:'Confirmed', scope:'visa sponsorship', text:line, url });
    if (/\b(?:stem opt|opt|h-?1b|work authorization|work authorisation)\b/i.test(line)) evidence.push({status:'Unknown',scope:/stem opt/i.test(line)?'STEM OPT':/\bopt\b/i.test(line)?'OPT':/h-?1b/i.test(line)?'H-1B':'current authorization',text:line,url});
  }
  const roles = evidence.filter(item => item.status !== 'Unknown');
  const policy = userEvidence.filter(item => item.scope === 'visa sponsorship' && item.kind === 'policy');
  const applicable = roles.length ? roles : policy;
  const negative = applicable.some(item => item.status === 'Not Supported');
  const positive = applicable.some(item => ['Confirmed','Likely'].includes(item.status));
  const history = userEvidence.some(item => item.kind === 'history' && item.status === 'Likely');
  const status = negative && positive ? 'Unknown' : negative ? 'Not Supported' : positive ? (roles.length ? 'Confirmed' : 'Likely') : history ? 'Likely' : 'Unknown';
  return { status, items:[...evidence,...userEvidence].slice(0, 24) };
}

export function preferenceDecision(job, raw = PREFERENCES) {
  const p = { ...PREFERENCES, ...raw };
  const title = normalized(job.title);
  const company = normalized(job.company);
  const reasons = [];
  const unknown = [];
  if (p.excludeTitles.some(value => normalized(value) && phrase(title, normalized(value)))) reasons.push('Excluded title');
  if (p.excludeCompanies.some(value => company && normalized(value) === company)) reasons.push('Excluded company');
  if (!titleRelevant(job.title, p)) reasons.push('Title does not match');
  for (const [field, label] of [['seniority','Seniority'],['employmentType','Employment type'],['workMode','Work arrangement']]) {
    if (conflicts(p[field], job[field])) reasons.push(label + ' does not match');
    if (p[field].length && !job[field]) unknown.push(label);
  }
  if (p.locations.length && !job.location) unknown.push('Location');
  if (job.locationCertain && !/remote/i.test(job.workMode ?? '') && conflicts(p.locations, job.location)) reasons.push('Location does not match');
  if (p.minimumPay) {
    const comparable = job.salary?.currency === p.currency && job.salary?.period === p.period && job.salary?.max > 0;
    if (comparable && job.salary.max < p.minimumPay) reasons.push('Compensation below minimum');
    if (!comparable) unknown.push('Compensation');
  }
  if (p.sponsorship === 'Required') {
    if (job.sponsorship?.status === 'Not Supported') reasons.push('Role excludes sponsorship');
    if (!job.sponsorship || job.sponsorship.status === 'Unknown') unknown.push('Sponsorship');
  }
  return { eligible: !reasons.length && !(p.strictUnknown && unknown.length), reasons, unknown };
}

export function matchScore({ skills, experience, seniority, domain }) {
  return Math.round(skills * .4 + experience * .3 + seniority * .2 + domain * .1);
}
export function localSlot(date, slots, graceMinutes = 2) {
  const hour = String(date.getHours()).padStart(2,'0');
  const minute = date.getHours() * 60 + date.getMinutes();
  const day = date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
  const slot = [...slots].sort().reverse().find(time => {
    const [h,m] = time.split(':').map(Number);
    return minute >= h * 60 + m && minute < h * 60 + m + graceMinutes;
  });
  return { day, slot, hour, key:slot && 'slot:' + day + ':' + slot };
}
export function backoffMs(failures, interval, retryAfter, random = Math.random) {
  const numeric = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '') - Date.now();
  const delay = Math.min(6 * 3_600_000, interval * 2 ** Math.min(failures, 8));
  return Math.max(0, numeric || 0, Math.round(delay * (.85 + random() * .3)));
}
