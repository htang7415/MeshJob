import regions from './regions.json' with {type:'json'};
import { COUNTRY_OPTIONS, normalizeLevels } from './preferences.js';

export const STAGES = ['Saved', 'Preparing', 'Applied', 'OA', 'Interview', 'Offer', 'Rejected', 'Withdrawn', 'Accepted'];
export const SLOTS = ['09:00'];
export const PREFERENCES = {
  titles: [], aliases: [], seniority: [], employmentType: [], locations: [], countries: [], workMode: [], freshnessHours: 24,
  sponsorship: 'Unspecified', minimumPay: null, currency: 'USD', period: 'year', industries: [], companies: [],
  skills: [], excludeCompanies: [], excludeTitles: [], maxYears: null, strictUnknown: false
};
export const DEFAULTS = {
  mode: 'Active', generation: 0, onboarded: false, preferences: PREFERENCES, profile: {}, slots: SLOTS,
  searchesPerRound: 3, roundsPerDay: 2, budget: 10, dailyBudget: 2, runBudget: 0.15, autoMatch: true, dailySearch: true,
  model: 'claude-haiku-5-5', draftModel: 'claude-haiku-5-5', directAlerts: true,
  gmail: false, mailProvider: 'gmail', markRead: false, gmailDays: 14, jdDays: 30, tombstoneDays: 180
};
const TRACKING = /^(utm_\w+|gh_src|lever-source|source|fbclid|gclid|ref_src)$/i;
const PRIVATE_QUERY = /^(?:access_token|id_token|refresh_token|sessionid|session_id|candidateId|applicationToken|authToken|token)$/i;
const MEANINGFUL_QUERY = ['gh_jid', 'jobId', 'job_id', 'requisitionId'];
const DENIED = /(^|\.)(linkedin\.com|jobright\.ai|simplify\.jobs|ycombinator\.com|workatastartup\.com|localhost|local|internal|test)$/i;

export const ATS_ORIGINS = ['https://*.greenhouse.io/*','https://*.ashbyhq.com/*','https://*.lever.co/*','https://*.myworkdayjobs.com/*',
  'https://*.myworkdaysite.com/*','https://*.smartrecruiters.com/*','https://*.workable.com/*'];
export const nowISO = () => new Date().toISOString();
export const trim = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const normalized = value => trim(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export const structuredValue = value => {
  if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) return false;
  try {
    const parsed=JSON.parse(value);
    return parsed!==null && typeof parsed==='object';
  } catch {
    return /^\s*(?:\[\s*)?\{\s*"[^"]+"\s*:/.test(value);
  }
};
export const list = value => Array.isArray(value) ? value.map(trim).filter(Boolean) : String(value ?? '').split(/[,\n]/).map(trim).filter(Boolean);
export function distinctValues(value) {
  if (structuredValue(value)) return [];
  const unique=new Map();
  for(const entry of list(value)) {
    if(!structuredValue(entry)&&!/^"[\w$-]+"\s*:/.test(entry)&&!unique.has(entry.toLowerCase())) unique.set(entry.toLowerCase(),entry);
  }
  return [...unique.values()];
}
export const validDate = value => !!value && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value));
export const exactDate = value => validDate(value) && /T\d{2}:\d{2}.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Date.parse(value) <= Date.now();
export const uid = () => crypto.randomUUID();
export const JOB_DESCRIPTION_LIMIT = 48_000;
export const workdayTenant = host => /^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host)?.[1];
export const workdayEmployer = host => host==='jda.wd5.myworkdayjobs.com'?'Blue Yonder':'';
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
// New needs strong evidence; old needs any credible earlier timestamp (spec 3.3).
export function freshness(job, hours = 24, at = Date.now()) {
  const floor = at - hours * 3_600_000;
  if (job.repost) return 'older';
  if (job.active && job.official && exactDate(job.postedAt)) return Date.parse(job.postedAt) >= floor ? 'verified' : 'older';
  if (validDate(job.ageFloor) && Date.parse(job.ageFloor) < floor) return 'older';
  if (validDate(job.firstSeenAt) && Date.parse(job.firstSeenAt) < floor) return 'older';
  if (job.active && !job.reopenedAt && job.lastAbsentAt) return 'detected';
  return 'unknown';
}
export const earliest = (...values) => values.filter(validDate).sort((a,b)=>Date.parse(a)-Date.parse(b))[0] ?? null;

const has = (pattern, text) => pattern.test(text);
export function levelOf(title, jd = '') {
  const role = ' '+normalized(title)+' ';
  if (has(/ (?:intern|internship|apprentice|co op|coop) /, role)) return 'Intern';
  if (has(/ (?:engineering|software|development|data science|machine learning|research) manager | director | head of | vp | vice president | chief /, role)) return 'Manager';
  if (has(/ (?:senior staff|staff|principal|distinguished|fellow) (?!nurse |accountant |pharmacist |physician |assistant )/, role)) return 'Staff+';
  if (has(/ (?:senior|sr|lead|iii|iv|3|4) /, role)) return 'Senior';
  if (has(/ (?:new grad|new graduate|graduate|early career|entry level|entry|junior|jr) /, role) || has(/ associate (?:software|engineer|developer|data|product|ml) /, role)
    || has(/ (?:engineer|developer|scientist|analyst) (?:i|1) /, role)) return 'Entry';
  if (has(/ (?:ii|2|mid level|intermediate) /, role)) return 'Mid';
  const years = minYears(jd);
  if (years == null) return '';
  return years <= 1 ? 'Entry' : years <= 4 ? 'Mid' : years <= 7 ? 'Senior' : 'Staff+';
}
export function minYears(text) {
  const found = [...String(text ?? '').slice(0,20000).matchAll(/\b(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\b(?:\s+of)?(?:\s+[\w/-]+){0,5}?\s+(?:experience|industry)/gi)]
    .map(match=>Number(match[1])).filter(value=>value<=20);
  return found.length ? Math.min(...found) : null;
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
const phrase = (text, word) => (' ' + text + ' ').includes(' ' + word + ' ');
const conflicts = (wanted, known) => wanted.length && known && !wanted.some(value => {
  const lhs = normalized(value);
  const rhs = normalized(known);
  return phrase(rhs, lhs) || phrase(lhs, rhs);
});
export function titleMatch(title, preferences) {
  const wanted = (preferences.titles ?? []).map(normalized).filter(Boolean);
  if (!wanted.length || !title) return '';
  const role = normalized(title);
  const expanded = new Set([...wanted, ...(preferences.aliases ?? []).map(normalized)]);
  for (const group of ALIASES) if (group.some(alias => wanted.some(value => phrase(value, alias)))) group.forEach(value => expanded.add(value));
  return [...expanded].find(value => value && phrase(role, value)) ?? null;
}
export const titleRelevant = (title, preferences) => titleMatch(title, preferences) !== null;

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

function workplaceBand(value) {
  return normalized(value)==='onsite'?'On-site':value;
}

const countryAliases=new Map(COUNTRY_OPTIONS.filter(name=>name!=='Georgia').map(name=>[normalized(name),name]));
for (const [alias,name] of [
  ['us','United States'],['u s','United States'],['usa','United States'],['u s a','United States'],['united states of america','United States'],
  ['uk','United Kingdom'],['u k','United Kingdom']
]) countryAliases.set(alias,name);

const US_CODES=new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));
const CA_CODES=new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));
const placeCountry=new Map([
  ...(regions.US??[]).filter(name=>name!=='Georgia').map(name=>[normalized(name),'United States']),
  ...(regions.CA??[]).map(name=>[normalized(name),'Canada']),
  ...Object.entries({'United States':'san francisco,new york,new york city,nyc,sf,bay area,sf bay area,silicon valley,seattle,austin,boston,los angeles,chicago,mountain view,palo alto,menlo park,sunnyvale,san jose,santa clara,redwood city,san mateo,south san francisco,foster city,redmond,bellevue,kirkland,denver,boulder,atlanta,pittsburgh,san diego,miami,dallas,houston,philadelphia,portland,salt lake city,raleigh,durham,nashville,detroit,minneapolis,phoenix,irvine,brooklyn,jersey city,arlington,reston,mclean,herndon,washington dc,ann arbor,columbus,st louis,baltimore,cupertino,oakland,berkeley',
    'United Kingdom':'london,manchester,edinburgh,cambridge uk,bristol,belfast,glasgow',Canada:'toronto,vancouver,montreal,ottawa,waterloo,calgary',
    Ireland:'dublin',Germany:'berlin,munich,hamburg,frankfurt',France:'paris',Netherlands:'amsterdam',Japan:'tokyo,osaka',India:'bangalore,bengaluru,hyderabad,pune,mumbai,new delhi,delhi,gurgaon,gurugram,chennai,noida',
    Australia:'sydney,melbourne,brisbane',Israel:'tel aviv',Switzerland:'zurich,geneva',Poland:'warsaw,krakow',Sweden:'stockholm',Spain:'madrid,barcelona',
    'South Korea':'seoul',China:'beijing,shanghai,shenzhen',Brazil:'sao paulo',Mexico:'mexico city',Singapore:'singapore',Taiwan:'taipei',Portugal:'lisbon',Denmark:'copenhagen'})
    .flatMap(([country,cities])=>cities.split(',').map(city=>[city,country]))
]);
function partCountry(raw) {
  const part=trim(raw);
  const code=part.replace(/^remote\s*[-–]?\s*/i,'');
  if(US_CODES.has(code)) return 'United States';
  if(CA_CODES.has(code)) return 'Canada';
  const key=normalized(part).replace(/^(?:remote|hybrid|on site|onsite) /,'').replace(/ (?:remote|hybrid|office|hq|area|metro area)$/,'');
  return countryAliases.get(key) ?? placeCountry.get(key) ?? null;
}
export function countriesFromLocation(location) {
  const places=String(location??'').split(/\s*(?:[;·|\n]|\s\/\s|\s+or\s+)\s*/).filter(Boolean);
  const countries=places.map(place=>[...new Set(place.split(/[,()]|\s[-–]\s/).map(partCountry).filter(Boolean))]);
  return countries.length&&countries.every(matches=>matches.length)?countries.flat():[];
}

export function preferenceDecision(job, raw = PREFERENCES) {
  const p = { ...PREFERENCES, ...raw };
  const title = normalized(job.title);
  const company = normalized(job.company);
  const reasons = [];
  const unknown = [];
  if (p.excludeTitles.some(value => normalized(value) && phrase(title, normalized(value)))) reasons.push('Excluded title');
  if (p.excludeCompanies.some(value => company && normalized(value) === company)) reasons.push('Excluded company');
  const matched = titleMatch(job.title, p);
  if (matched === null) reasons.push('Title does not match');
  const levels = normalizeLevels(p.seniority), jobLevel = normalizeLevels(job.seniority)[0];
  if (levels.length && jobLevel && !levels.includes(jobLevel)) reasons.push('Level does not match');
  if (levels.length && !jobLevel) unknown.push('Level');
  for (const [field, label] of [['employmentType','Employment type'],['workMode','Workplace type']]) {
    const comparable=field==='workMode'?workplaceBand:value=>value;
    if (conflicts(p[field].map(comparable), comparable(job[field]))) reasons.push(label + ' does not match');
    if (p[field].length && !job[field]) unknown.push(label);
  }
  if (typeof p.maxYears === 'number' && Number.isFinite(p.maxYears) && Number.isFinite(job.minYears) && job.minYears > Number(p.maxYears)) reasons.push('Requires more experience');
  if (p.countries.length) {
    const countries=job.countries?.length?job.countries:countriesFromLocation(job.locationDetails||job.location);
    if (!countries.length) unknown.push('Country');
    if (countries.length && countries.every(country=>conflicts(p.countries,country))) reasons.push('Country does not match');
  }
  if (p.locations.length && !job.location) unknown.push('Location');
  if (job.locationCertain && !/remote/i.test(job.workMode ?? '') && conflicts(p.locations, job.locationDetails||job.location)) reasons.push('Location does not match');
  if (p.minimumPay) {
    const comparable = job.salary?.currency === p.currency && job.salary?.period === p.period && job.salary?.max > 0;
    if (comparable && job.salary.max < p.minimumPay) reasons.push('Compensation below minimum');
    if (!comparable) unknown.push('Compensation');
  }
  if (p.sponsorship === 'Required') {
    if (job.sponsorship?.status === 'Not Supported') reasons.push('Role excludes sponsorship');
    if (!job.sponsorship || job.sponsorship.status === 'Unknown') unknown.push('Sponsorship');
  }
  return { eligible: !reasons.length && !(p.strictUnknown && unknown.length), reasons, unknown, matched: matched || '' };
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
