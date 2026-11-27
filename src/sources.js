import { parseDocument, DomUtils } from 'htmlparser2';
import { canonicalUrl, publicUrl, hasJobPath, exactDate, earliest, JOB_DESCRIPTION_LIMIT, levelOf, trim, workdayEmployer } from './domain.js';

const { findAll, findOne, textContent } = DomUtils;
const pathToken = /^[\w.-]{1,100}$/;
export const PROVIDERS = ['greenhouse','ashby','lever','workday','rss','careers','github'];
const JOB_AGGREGATORS=new Set(['weworkremotely.com','remotive.com','jobicy.com','himalayas.app','indeed.com','glassdoor.com','ziprecruiter.com']);
const employment = { FullTime:'Full-time', PartTime:'Part-time', Intern:'Internship', Contract:'Contract', Temporary:'Temporary', FULL_TIME:'Full-time', PART_TIME:'Part-time', CONTRACTOR:'Contract', INTERN:'Internship' };
const period = value => String(value??'').toLowerCase().replace(/^per[- ]/,'').replace(/^(?:annual|annually|yearly)$/,'year').replace(/^(hour|week|month)ly$/,'$1');
const titleCase = value => value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : '';
const children = node => node?.children ?? [];
const element = (node, name) => children(node).find(child => child.name === name);
const text = (node, name) => {
  const target=name?element(node,name):node;
  return target?trim(textContent(target)):'';
};
const tags = (root, name) => findAll(node => node.name === name, children(root));
const absolute = (value, base) => {
  try { return value ? publicUrl(new URL(value,base).href)?.href ?? '' : ''; } catch { return ''; }
};
export function plain(html) {
  const doc = parseDocument(String(html ?? ''));
  const blocks = new Set(['p','li','br','div','h1','h2','h3','tr']);
  function read(nodes) {
    return nodes.map(node => {
      if (node.type === 'text') return node.data;
      if (['script','style','noscript','template'].includes(node.name)) return '';
      const content = read(children(node));
      return blocks.has(node.name) ? '\n' + content + '\n' : content;
    }).join(' ');
  }
  return read(doc.children).split('\n').map(trim).filter(Boolean).join('\n').slice(0, JOB_DESCRIPTION_LIMIT);
}

export function detectSource(value, hint = '') {
  const raw = trim(value);
  const url = raw.length<=460 ? publicUrl(raw) : null;
  if (!url) throw new Error('Enter a supported public HTTPS URL.');
  const {hostname,origin} = url;
  const parts = url.pathname.split('/').filter(Boolean);
  let provider, tenant, endpoint, site;
  if (['boards.greenhouse.io','job-boards.greenhouse.io','boards-api.greenhouse.io'].includes(hostname)) {
    provider = 'greenhouse'; tenant = hostname === 'boards-api.greenhouse.io' ? parts[2] : parts[0];
    endpoint = 'https://boards-api.greenhouse.io/v1/boards/' + tenant + '/jobs';
  } else if (['jobs.ashbyhq.com','api.ashbyhq.com'].includes(hostname)) {
    provider = 'ashby'; tenant = hostname === 'api.ashbyhq.com' ? parts[2] : parts[0];
    endpoint = 'https://api.ashbyhq.com/posting-api/job-board/' + tenant + '?includeCompensation=true';
  } else if (/^(jobs|api)\.(eu\.)?lever\.co$/.test(hostname)) {
    provider = 'lever'; tenant = hostname.startsWith('api.') ? parts[2] : parts[0];
    site = hostname.includes('.eu.') ? 'eu' : 'us';
    endpoint = 'https://api.' + (site === 'eu' ? 'eu.' : '') + 'lever.co/v0/postings/' + tenant + '?mode=json';
  } else if (/^[\w-]+\.wd\d+\.myworkdayjobs\.com$/.test(hostname)) {
    provider = 'workday'; tenant = hostname.split('.')[0];
    site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0]) ? parts[1] : parts[0];
    endpoint = origin + '/wday/cxs/' + tenant + '/' + site + '/jobs';
  } else if (hostname === 'github.com' || hostname === 'raw.githubusercontent.com') {
    if (parts.length < 2 || !parts.slice(0,2).every(part => pathToken.test(part))) throw new Error('Enter a GitHub repository or Markdown file.');
    provider = 'github'; tenant = parts.slice(0,2).join('/');
    const branch = hostname.startsWith('raw.') ? parts[2] : parts[2] === 'blob' ? parts[3] : 'HEAD';
    const file = (hostname.startsWith('raw.') ? parts.slice(3) : parts.slice(4)).join('/') || 'README.md';
    if (!branch || !pathToken.test(branch) || !/^[\w./% -]+\.md$/i.test(file) || file.split('/').includes('..')) throw new Error('Select a Markdown list on a branch without slash characters.');
    site = branch + '/' + file;
    endpoint = 'https://raw.githubusercontent.com/' + tenant + '/' + site;
  } else {
    provider = hint === 'rss' || /\.(rss|xml|atom)$/i.test(url.pathname) || /\/(rss|feed|atom)\/?$/.test(url.pathname) ? 'rss' : 'careers';
    tenant = canonicalUrl(url.href);
    endpoint = tenant;
  }
  if (!tenant || (['greenhouse','ashby','lever','workday'].includes(provider) && !pathToken.test(tenant)) || (provider === 'workday' && !pathToken.test(site))) throw new Error('Could not identify the board. Paste its public Careers URL.');
  const id = [provider, tenant, site ?? ''].join(':').toLowerCase();
  return { id, url:canonicalUrl(url.href), provider, tenant, site, endpoint, name:workdayEmployer(hostname)||tenant,
    interval:10, enabled:true, origin:new URL(endpoint).origin };
}

export function postingIdentity(value) {
  const url = publicUrl(value);
  if (!url) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    const source = detectSource(url.href);
    let id;
    if (/^(greenhouse|ashby|lever)$/.test(source.provider)) {
      if (source.provider === 'greenhouse') id = url.searchParams.get('token') ?? parts[parts.indexOf('jobs') + 1];
      else id = parts[1];
      if (source.provider === 'greenhouse' && !/^\d+$/.test(id ?? '')) return null;
      if (['ashby','lever'].includes(source.provider) && !/^[a-f\d-]{32,36}$/i.test(id ?? '')) return null;
    } else if (source.provider === 'workday') {
      id = workdayId(url.pathname);
    }
    return id ? { key:source.id + ':' + id, source, externalId:id } : null;
  } catch { return null; }
}
const workdayId = path => {
  const parts = path.split('/');
  const index = parts.indexOf('job');
  return index < 0 ? undefined : parts.slice(index+1).findLast(part=>/^.+_[\w-]+$/.test(part))?.split('_').at(-1);
};
export class SourceError extends Error {
  constructor(message, status = 0, retryAfter = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export async function fetchPublic(value, { signal, method = 'GET', body, etag, modified, ...other } = {}) {
  const url = publicUrl(value);
  if (!url) throw new SourceError('The URL is outside supported public HTTPS origins.');
  const headers = { Accept:'application/json, application/rss+xml, application/atom+xml, text/html, text/plain' };
  if (body) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  if (modified) headers['If-Modified-Since'] = modified;
  const controller = AbortSignal.timeout(14000);
  const response = await fetch(url.href,{ method, headers, body:body ? JSON.stringify(body) : undefined,
    redirect:'error', credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store',
    signal:signal ? AbortSignal.any([controller,signal]) : controller, ...other });
  if (response.status===206||response.headers.has('content-range')) throw new SourceError('Source returned a partial HTTP response.',response.status);
  if (!response.ok && response.status !== 304) throw new SourceError('Source returned HTTP ' + response.status,response.status,response.headers.get('retry-after'));
  return response;
}
async function limited(response, limit = 30_000_000) {
  if (Number(response.headers.get('content-length')) > limit) throw new SourceError('Source exceeded the response limit.');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let result = '';
  while (true) {
    const item = await reader.read();
    if (item.done) return result + decoder.decode();
    size += item.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new SourceError('Source exceeded the response limit.');
    }
    result += decoder.decode(item.value, { stream:true });
  }
}
const json = async response => JSON.parse(await limited(response));

function locationOf(posting) {
  const inputs = [posting.jobLocation,posting.applicantLocationRequirements].flat(Infinity).filter(Boolean);
  return [...new Set(inputs.map(item => {
    const a = item.address ?? item;
    return [a.addressLocality,a.addressRegion,a.addressCountry?.name ?? a.addressCountry,a.name].filter(v => typeof v === 'string' && v).join(', ');
  }).filter(Boolean))].join(' · ');
}
function payOf(pay) {
  const value = pay?.value ?? {};
  const min = Number(value.minValue ?? value.value);
  const max = Number(value.maxValue ?? value.value);
  if (!pay?.currency || (!Number.isFinite(min) && !Number.isFinite(max))) return undefined;
  return { currency:pay.currency, min:Number.isFinite(min)?min:null, max:Number.isFinite(max)?max:null, period:period(value.unitText) };
}
export function jsonPostings(html, base) {
  const doc = parseDocument(html);
  const found = [];
  function walk(value) {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().includes('JobPosting')) found.push(value);
    if (value['@graph']) walk(value['@graph']);
    if (value.itemListElement) value.itemListElement.forEach(item => walk(item.item ?? item));
  }
  tags(doc,'script').filter(node => node.attribs.type?.split(';')[0].trim() === 'application/ld+json').forEach(node => {
    try { walk(JSON.parse(children(node).map(child => child.data ?? '').join(''))); } catch { /* Ignore unrelated invalid markup. */ }
  });
  return found.map(item => {
    const url = absolute(item.url ?? item.mainEntityOfPage?.['@id'] ?? (found.length === 1 ? base : ''),base);
    return {
      externalId:trim(item.identifier?.value ?? item.identifier), url, title:trim(item.title),
      company:trim(item.hiringOrganization?.name), location:locationOf(item),countries:[item.jobLocation].flat().map(place=>place?.address?.addressCountry)
        .map(country=>country?.name??country).filter(country=>typeof country==='string'&&country).map(country=>countriesName(country)),locationCertain:!!item.jobLocation && item.jobLocationType!=='TELECOMMUTE',
      workMode:item.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '',
      employmentType:employment[item.employmentType] ?? trim(item.employmentType), salary:payOf(item.baseSalary),
      postedAt:item.datePosted, dateKind:'JobPosting.datePosted', validThrough:item.validThrough,
      jd:plain(item.description), official:!!url && new URL(url).origin === new URL(base).origin &&
        !JOB_AGGREGATORS.has(new URL(url).hostname.replace(/^www\./,''))
    };
  }).filter(item => item.title && item.url && !(item.validThrough && Date.parse(item.validThrough) < Date.now()));
}
const countryNames=new Intl.DisplayNames(['en'],{type:'region'});
const countriesName=value=>typeof value!=='string'?'':/^[A-Z]{2}$/.test(value)?countryNames.of(value):
  ({USA:'United States',UK:'United Kingdom'})[value]??value;
// Workday shows only relative labels; they bound age from below but never prove recency.
export function workdayAgeFloor(label, at = Date.now()) {
  const text=String(label??'').toLowerCase();
  const days=/yesterday/.test(text)?1:Number(/(\d+)\+?\s*days?\s*ago/.exec(text)?.[1]);
  return Number.isFinite(days)&&days>=1?new Date(at-days*86_400_000).toISOString():null;
}
function record(source, item) {
  const url = canonicalUrl(item.url);
  if (!publicUrl(url) || !item.title) throw new SourceError('Listing contained an invalid job identity.');
  const identity = postingIdentity(url);
  const externalId = item.externalId || identity?.externalId || url;
  const key = source.id + ':' + externalId;
  const keys = [...new Set([key,identity?.key].filter(Boolean))];
  const postedAt = exactDate(item.postedAt) ? new Date(item.postedAt).toISOString() : null;
  return { ...item, seniority:item.seniority||levelOf(item.title), ageFloor:earliest(item.ageFloor, postedAt), externalId, key, keys, url, company:item.company || source.name || source.tenant,
    official:item.official ?? !['rss','github'].includes(source.provider), provider:identity?.source.provider ?? source.provider,
    postedAt,
    dateEvidence:item.postedAt ? { date:item.postedAt, kind:item.dateKind, url:item.evidenceUrl ?? source.endpoint } : undefined };
}

export async function respectWorkdayRobots(source,fetcher,signal) {
  if(source.provider!=='workday'||!source.permitted) return;
  let response;
  try {response=await fetcher(source.origin+'/robots.txt',{signal});}
  catch(error) {
    if(error.status===404) return;
    error.robots=true;throw error;
  }
  const groups=[];
  let group={agent:[],rules:[]};
  const flush=()=>{if(group.agent.length) groups.push(group);group={agent:[],rules:[]};};
  for(const line of (await limited(response,120_000)).split('\n')) {
    const [_,directive,value]=/^\s*([a-z-]+)\s*:\s*([^#]*?)\s*(?:#.*)?$/i.exec(line)??[];
    if(directive?.toLowerCase()==='user-agent') {
      if(group.rules.length) flush();
      group.agent.push(value.toLowerCase());
    } else if (/^(?:allow|disallow)$/i.test(directive??'')&&value?.startsWith('/')) {
      group.rules.push({allow:directive.toLowerCase()==='allow',path:value});
    }
  }
  flush();
  const specific=groups.filter(entry=>entry.agent.includes('meshjob'));
  const rules=(specific.length?specific:groups.filter(entry=>entry.agent.includes('*'))).flatMap(entry=>entry.rules);
  const endpoints=[new URL(source.endpoint).pathname,'/'+source.site];
  for(const target of endpoints) {
    const rule=rules.filter(entry=>{
      const trailing=entry.path.endsWith('$');
      const fragment=trailing?entry.path.slice(0,-1):entry.path;
      const pattern=fragment.split('*').map(value=>value.replace(/[\^$.*+?()[\]{}|]/g,'\\$&')).join('.*');
      return new RegExp('^'+pattern+(trailing?'$':'')).test(target);
    }).sort((a,b)=>b.path.length-a.path.length||Number(b.allow)-Number(a.allow))[0];
    if(rule&&!rule.allow) {
      const error=new SourceError('This career site disallows automated checks for the required path.');
      error.robots=true;throw error;
    }
  }
}

async function workday(source, fetcher, options) {
  if (!source.permitted) throw new SourceError('Confirm that this career site permits automated public access before connecting.');
  const result = [];
  let total;
  for (let offset = 0; offset < 4000; offset += 20) {
    const response = await fetcher(source.endpoint,{...options,method:'POST',body:{appliedFacets:{},limit:20,offset,searchText:''}});
    const page = await json(response);
    if (!Number.isInteger(page.total) || page.total < 0 || page.total > 4000 || !Array.isArray(page.jobPostings) || (total != null && total !== page.total) || page.jobPostings.length !== Math.min(20,page.total - offset)) throw new SourceError('Workday pagination was incomplete or changed during the check.');
    total = page.total;
    for (const line of page.jobPostings) {
      if (typeof line.externalPath!=='string' || !line.externalPath.startsWith('/job/')) throw new SourceError('Workday returned an unrecognized posting path.');
      const externalId = workdayId(line.externalPath ?? '') ?? line.bulletFields?.[0] ?? line.externalPath;
      const url = absolute('/' + source.site + line.externalPath,source.origin);
      result.push(record(source,{ externalId,url,title:line.title,location:line.locationsText,postingLabel:line.postedOn,ageFloor:workdayAgeFloor(line.postedOn) }));
    }
    if (result.length === total) {
      if (new Set(result.map(item => item.key)).size !== total) throw new SourceError('Workday pagination repeated job IDs.');
      return { items:result };
    }
  }
  throw new SourceError('Workday pagination exceeded the supported limit.');
}

function githubRows(data) {
  const results = [];
  const document = parseDocument(data);
  let lastCompany = '';
  function add(columns,urls) {
    const url = urls.find(value => postingIdentity(value));
    if (!url || columns.length < 2) return;
    const clean = column => plain(column.replace(/!?\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\*\*/g,''));
    const employer = clean(columns[0]);
    if (employer && !/^[↳↪⤷\-–—]+$/u.test(employer)) lastCompany = employer;
    const title = clean(columns[1]);
    if (title) results.push({url,title,company:lastCompany,location:clean(columns[2] ?? ''),official:false});
  }
  for (const row of tags(document,'tr')) {
    const columns = tags(row,'td');
    add(columns.map(node=>text(node)),tags(row,'a').map(node=>node.attribs.href));
  }
  lastCompany = '';
  for (const line of data.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const urls = [...line.matchAll(/https:\/\/[^\s<>"')\]]+/g)].map(match => match[0].replace(/\|$/, ''));
    add(line.split('|').slice(1,-1),urls);
  }
  if (!results.length) throw new SourceError('No supported job rows in this Markdown list.');
  return results;
}
function feedRows(data, source) {
  const doc = parseDocument(data,{xmlMode:true});
  const root = doc.children.find(node => ['rss','feed','rdf:RDF'].includes(node.name));
  if (!root) throw new SourceError('The URL did not return RSS or Atom.');
  if (!data.includes('</'+root.name+'>')) throw new SourceError('The feed snapshot was incomplete.');
  return [...tags(root,'item'),...tags(root,'entry')].flatMap(node => {
    const link = children(node).find(item=>item.name==='link'&&(!item.attribs.rel||item.attribs.rel==='alternate'));
    const url = absolute(link?.attribs?.href ?? text(link),source.url);
    const heading = text(node,'title');
    if (!url || !heading) return [];
    const combined = new URL(url).hostname==='weworkremotely.com' ? /^(.*?):\s*(.+)$/.exec(heading) : null;
    return [{url,title:combined?.[2]??heading,company:text(node,'company')||combined?.[1]||'Unknown employer',attribution:source.name,jd:plain(text(node,'description') || text(node,'summary')),official:false,
      postingLabel:text(node,'pubDate') || text(node,'published')}];
  });
}

export async function collect(source, { fetcher = fetchPublic, signal, full = false } = {}) {
  const options = {signal, ...(full ? {} : {etag:source.etag,modified:source.modified})};
  if (source.provider === 'workday') return workday(source,fetcher,options);
  const response = await fetcher(source.endpoint, options);
  if (response.status === 304) return { unchanged:true };
  let items;
  if (source.provider === 'greenhouse') {
    const data = await json(response);
    if (!Array.isArray(data.jobs) || (data.meta?.total != null && data.meta.total !== data.jobs.length)) throw new SourceError('Greenhouse listing was incomplete.');
    items = data.jobs.filter(job => job.internal_job_id !== null).map(job => ({
      externalId:String(job.id), requisition:job.requisition_id, title:job.title, company:data.name, location:job.location?.name,
      url:job.absolute_url, updatedAt:job.updated_at, postedAt:job.first_published, dateKind:'Greenhouse.first_published', jd:job.content ? plain(job.content) : undefined
    }));
  } else if (source.provider === 'ashby') {
    const data = await json(response);
    if (!Array.isArray(data.jobs)) throw new SourceError('Invalid Ashby listing.');
    items = data.jobs.filter(job => job.isListed !== false).map(job => {
      const comp = job.compensation?.summaryComponents?.find(item => item.compensationType === 'Salary');
      const addresses=[job.address,...(job.secondaryLocations??[]).map(location=>location.address)]
        .map(address=>address?.postalAddress).filter(Boolean);
      const locations=addresses.map(address=>[
        address.addressLocality,address.addressRegion,countriesName(address.addressCountry)
      ].filter(Boolean).join(', '));
      return {
        externalId:postingIdentity(job.jobUrl)?.externalId, title:job.title, location:job.location,
        locationDetails:[job.location,...locations].filter(Boolean).join(' · '),
        countries:addresses.map(address=>countriesName(address.addressCountry)).filter(Boolean),
        locationCertain:!!addresses[0]?.addressLocality&&!job.isRemote,
        workMode:titleCase(job.workplaceType ?? (job.isRemote ? 'Remote' : '')), employmentType:employment[job.employmentType] ?? job.employmentType,
        url:job.applyUrl || job.jobUrl, updatedAt:job.publishedAt, postedAt:job.publishedAt, dateKind:'Ashby.publishedAt', jd:job.descriptionPlain?.slice(0,48_000) ?? plain(job.descriptionHtml),
        salary:comp ? {min:comp.minValue,max:comp.maxValue,currency:comp.currency,period:period(comp.interval)} : undefined };
    });
  } else if (source.provider === 'lever') {
    const data = await json(response);
    if (!Array.isArray(data) || data.length >= 10000) throw new SourceError('Invalid or excessive Lever listing.');
    items = data.map(job => ({ externalId:job.id,title:job.text,
      postedAt:Number.isFinite(job.createdAt)?new Date(job.createdAt).toISOString():undefined,dateKind:'Lever.createdAt',
      countries:typeof job.country==='string'&&/^[A-Z]{2}$/.test(job.country)?[countriesName(job.country)]:undefined,location:job.categories?.allLocations?.join(' · ') || job.categories?.location,
      employmentType:job.categories?.commitment,workMode:titleCase(job.workplaceType),url:job.applyUrl || job.hostedUrl,
      jd:[job.descriptionPlain,job.additionalPlain,...(job.lists ?? []).map(section => plain(section.text + ' ' + section.content))].filter(Boolean).join('\n').slice(0,48_000),
      salary:job.salaryRange ? {min:job.salaryRange.min,max:job.salaryRange.max,currency:job.salaryRange.currency,period:period(job.salaryRange.interval)} : undefined }));
  } else {
    const data = await limited(response);
    items = source.provider === 'github' ? githubRows(data) : source.provider === 'rss' ? feedRows(data,source) : jsonPostings(data,source.url);
    if (source.provider === 'careers' && !items.length) {
      const doc = parseDocument(data);
      const feed = tags(doc,'link').find(node => /^(application\/(rss|atom)\+xml)$/.test(node.attribs.type ?? ''));
      const linked = tags(doc,'a').concat(tags(doc,'iframe')).map(node => absolute(node.attribs.href ?? node.attribs.src,source.url))
        .filter(url => /(?:greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com)$/.test(new URL(url || source.url).hostname))
        .map(url => { try { return detectSource(url); } catch { return null; } }).filter(Boolean);
      const boards = [...new Map(linked.map(board => [board.id,board])).values()];
      const alternatives = [...boards.map(board => board.url), absolute(feed?.attribs?.href,source.url)].filter(Boolean);
      if (alternatives.length) throw new SourceError('Detected board or feed. Test its URL separately: ' + alternatives.slice(0,4).join(' · '));
      throw new SourceError('No public JobPosting data found. Paste a supported board or RSS URL.');
    }
  }
  const byKey = new Map();
  for (const item of items) {
    const row = record(source,item);
    if (byKey.has(row.key) && !['github','rss'].includes(source.provider)) throw new SourceError('Listing included duplicate provider IDs.');
    byKey.set(row.key,row);
  }
  return { items:[...byKey.values()],etag:response.headers.get('etag'),modified:response.headers.get('last-modified') };
}


export async function verifyOfficialPosting(item,source,fetcher,signal) {
  if (!item.postedAt || source.provider!=='careers' || item.url===source.endpoint) return item;
  if (new URL(item.url).origin!==source.origin) return {...item,postedAt:null};
  try {
    const response=await fetcher(item.url,{signal});
    const candidates=jsonPostings(await limited(response,3_000_000),item.url);
    const listing=candidates.find(row=>canonicalUrl(row.url)===item.url&&row.official&&exactDate(row.postedAt));
    return listing?{...item,...listing,postedAt:new Date(listing.postedAt).toISOString(),dateEvidence:{date:listing.postedAt,kind:listing.dateKind,url:item.url}}:
      {...item,postedAt:null};
  } catch(error) {
    if (signal?.aborted) throw error;
    return {...item,postedAt:null,detailError:error.message};
  }
}
export async function jobDetails(item, source, fetcher, signal) {
  if (item.jd) return item;
  if (source.provider === 'greenhouse' && /^\d+$/.test(item.externalId)) {
    const response = await fetcher(source.endpoint + '/' + item.externalId,{signal});
    const row = await json(response);
    if (String(row.id) !== item.externalId) throw new SourceError('Job detail identity did not match.');
    if (row.content) {
      const first = plain(row.content);
      return { ...item,jd:/<\/?[a-z][^>]*>/i.test(first) ? plain(first) : first,requisition:row.requisition_id ?? item.requisition };
    }
  }
  if (source.provider === 'workday') {
    const url = new URL(item.url);
    const path = url.pathname.slice(('/' + source.site).length);
    const response = await fetcher(source.origin + '/wday/cxs/' + source.tenant + '/' + source.site + path,{signal});
    const info = (await json(response)).jobPostingInfo;
    if (!info) throw new SourceError('Missing Workday detail.');
    return { ...item,jd:plain(info.jobDescription),requisition:info.jobReqId ?? item.externalId };
  }
  return item;
}
