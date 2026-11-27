import { distinctValues, httpUrl, normalized, structuredValue } from './domain.js';

export function greenhouseEmbed(value) {
  const url=httpUrl(value);
  if(url?.protocol!=='https:' || url.port || !['job-boards.greenhouse.io','boards.greenhouse.io'].includes(url.hostname) ||
     url.pathname!=='/embed/job_app') return null;
  const board=url.searchParams.get('for'), id=url.searchParams.get('token');
  return /^[a-z0-9_-]{1,100}$/i.test(board??'')&&/^\d{1,20}$/.test(id??'') ? {origin:url.origin,board:board.toLowerCase(),id} : null;
}

export const PROFILE_KEYS = {
  givenName:'First name',familyName:'Last name',fullName:'Full name',preferredName:'Preferred name',email:'Email',
  phone:'Phone',phoneCountry:'Phone country code',address1:'Address line 1',address2:'Address line 2',
  city:'City',region:'State or region',postal:'Postal code',country:'Country',linkedin:'LinkedIn URL',
  website:'Website or portfolio',github:'GitHub URL',currentEmployer:'Current employer',currentTitle:'Current title'
};

export function criticalField(value) {
  return /\b(?:authori[sz](?:ation|ed)|right to work|work eligibility|permission to work|work legally|legally permitted|petition on your behalf|visa|sponsor(?:ship)?|citizen(?:ship)?|permanent resident|h1b|h 1b|stem opt|opt|immigration|work permit|legal(?:ly)? eligible|eligible to work|employment eligibility|security clearance|criminal|convict|felony|drug test|background check|gender|sex(?:ual orientation)?|lgbtq(?:ia)?|race|ethnic(?:ity)?|veteran|disabilit(?:y|ies)|eeo|diversity|demographic|age|birth|native american|indigenous|hispanic|latino|pronouns?|government id|social security|ssn)\b/.test(normalized(value));
}
export function consentField(value) {
  return /\b(?:i agree|i accept|agree to|accept the|consent|certif(?:y|ication)|affirm|acknowledge|privacy policy|privacy notice|terms and conditions|signature|sign your|electronic sign|legally binding|accuracy of (?:the )?information)\b/.test(normalized(value));
}

const yesNo=['Yes','No'];
const optionalDisclosure=['Yes','No','Prefer not to answer'];
export const ANSWER_PRESETS=[
  {question:'Countries where you want to work',countries:true,aliases:['In which countries would you like to work?','Which countries do you want to work in?']},
  {question:'Are you a citizen of the United States?',choices:yesNo,aliases:['Are you a U.S. citizen?','Are you a US citizen?']},
  {question:'Are you legally authorized to work in the United States?',choices:yesNo,aliases:['Are you legally authorized to work in the US?','Are you legally authorized to work in the U.S.?','Are you authorized to work in the United States?']},
  {question:'Will you now or in the future require employer sponsorship in the United States?',choices:yesNo,
    aliases:['Will you now or in the future require sponsorship to work in the US?','Will you now or in the future require sponsorship to work in the United States?']},
  {question:'United States: Authorization basis',aliases:['Authorization basis (United States)']},
  {question:'United States: Work permit or visa type',aliases:['Work permit or visa type (United States)']},
  {question:'Do you have a disability?',choices:optionalDisclosure},
  {question:'Do you identify as LGBTQ+?',choices:optionalDisclosure},
  {question:'What is your gender?',choices:['Male','Female','Non-binary','Prefer not to answer']},
  {question:'Are you a veteran?',choices:optionalDisclosure},
  {question:'How would you identify your race?'},
  {question:'Are you Hispanic or Latino?',choices:optionalDisclosure},
  {question:'How would you describe your sexual orientation? (Mark all that apply)',aliases:['How would you describe your sexual orientation?']},
  {question:'What are your pronouns?'}
];
const questionText=value=>normalized(value).replace(/\b(?:required|optional)$/, '').trim();
const aliases=new Map(ANSWER_PRESETS.flatMap(preset=>(preset.aliases??[]).map(alias=>[questionText(alias),questionText(preset.question)])));
export const fieldQuestion = value => {
  const text=questionText(value);
  return aliases.get(text)??text;
};
const transforms = {
  'given-name':'givenName','family-name':'familyName',name:'fullName',nickname:'preferredName',email:'email',tel:'phone',
  'tel-country-code':'phoneCountry','address-line1':'address1','street-address':'address1','address-line2':'address2',
  'address-level2':'city','address-level1':'region',country:'country','country-name':'country','postal-code':'postal',
  organization:'currentEmployer','organization-title':'currentTitle'
};
const rules = [
  ['givenName',/^(?:legal )?(?:first|given|forename) name$|^(?:first|firstname|forename)$/],
  ['familyName',/^(?:legal )?(?:last|family|sur) name$|^surname$|^last$|^lastname$/],
  ['preferredName',/^(?:preferred|chosen|display) (?:(?:first|given) )?name$/],
  ['fullName',/^(?:(?:legal )?full |applicant |your )?name$|^fullname$/],
  ['email',/^(?:(?:primary|contact|personal|login|confirm|re enter) )?e ?mail(?: address)?$/],
  ['phoneCountry',/^(?:phone |telephone |mobile )?country (?:dialing )?code$/],
  ['phone',/^(?:(?:primary|contact|mobile|home|cell|daytime) )?(?:phone|telephone|mobile|cell)(?: number)?$/],
  ['address2',/^(?:(?:street |home |mailing )?address (?:line )?2|apt(?: suite)?|apartment|suite)(?: number)?$/],
  ['address1',/^(?:(?:street |home |mailing )?address(?: (?:line )?1)?|street)$/],
  ['city',/^(?:home |current )?(?:city|town|municipality)$/],
  ['region',/^(?:home |current )?(?:state|province|region|state province(?: region)?|territory)$/],
  ['postal',/^(?:zip|zip postal|postal|post) code$|^zip$/],
  ['country',/^(?:current |home )?country(?: (?:of )?residence| region)?$/],
  ['linkedin',/^linkedin(?: profile| url| profile url)?$/],
  ['github',/^github(?: profile| url| profile url)?$/],
  ['website',/^(?:personal )?(?:website|portfolio)(?: link| url)?$/],
  ['currentEmployer',/^(?:current employer|current company|company name|employer name)$/],
  ['currentTitle',/^(?:current title|current job title|current position|job title)$/]
];
export function fieldKey(field) {
  const name = fieldQuestion(field.label);
  const identifiers = normalized(String(field.name ?? '').replace(/([a-z])([A-Z])/g,'$1 $2'));
  if (criticalField(name+' '+identifiers) || consentField(name+' '+identifiers) || field.type==='password') return null;
  if (field.type === 'file') {
    if (/\b(?:resume|résumé|curriculum vitae|cv)\b/.test(name+' '+identifiers)) return 'resume';
    if (/\bcover letter\b/.test(name+' '+identifiers)) return 'cover';
    return null;
  }
  if (field.type==='textarea' && /^cover letter(?: text)?$/.test(name)) return 'coverText';
  if (field.group) return null;
  if (['text','textarea','select','skill-picker'].includes(field.type) && /^(?:add |search for )?skills$/.test(name)) return 'skills';
  const exact=rules.find(([,r])=>r.test(name))?.[0];
  if (exact) return exact;
  const hasLabel=name && name!==identifiers && field.labelSource!=='identifier';
  const inferred=field.autocomplete && transforms[field.autocomplete];
  if (inferred && (!hasLabel || /^(?:your identity|your information|email|phone)$/.test(name))) return inferred;
  if (hasLabel) return null;
  if (field.type==='email') return 'email';
  if (field.type==='tel') return 'phone';
  return rules.find(([,r])=>r.test(identifiers))?.[0] ?? null;
}

export const registrationEmailField=field=>['text','email'].includes(field.type)&&fieldKey(field)==='email';

function rowValue(field, profile) {
  if (!field.group) return null;
  const rows = field.group.kind === 'education' ? profile.education : profile.experience;
  const row = rows?.[field.group.index];
  if (!row) return null;
  const label = fieldQuestion(field.label);
  const raw = fieldQuestion(String(field.name ?? '').replace(/([a-z])([A-Z])/g,'$1 $2'));
  const keys = {
    education:[['school',/^(?:school|university|college|institution|school or university)(?: name)?$/],['degree',/^degree$/],['field',/^(?:field of study|major|discipline)$/],['gpa',/^gpa$/]],
    experience:[['employer',/^(?:employer|company|organization)(?: name)?$/],['title',/^(?:job title|position|role|title)$/],['location',/^location$/],['description',/^(?:description|responsibilities|role description)$/]]
  };
  const date = value => {
    if (/^(?:start date|start month|start year|from)$/.test(value)) return 'start';
    if (/^(?:end date|end month|end year|to)$/.test(value)) return 'end';
    return null;
  };
  const currentLabel=field.group.kind==='education'
    ? /^(?:i )?(?:currently study here|am currently enrolled)(?: at this (?:school|university|college))?$/
    : /^(?:i )?currently work (?:here|in this role|at this company)$|^current (?:job|role|position)$/;
  if(field.type==='checkbox') return row.current===true&&currentLabel.test(label)?'true':null;
  const time = date(label) ?? date(raw);
  if(time==='end' && row.current===true) return null;
  if (time && row[time]) {
    if (field.type==='month') return row[time].slice(0,7);
    if (field.type==='date' && /^\d{4,}-\d{2}$/.test(row[time])) return null;
    if (label.includes('month')) return row[time].slice(5,7);
    if (label.includes('year')) return row[time].slice(0,4);
    return row[time];
  }
  const key = keys[field.group.kind]?.find(([,pattern])=>pattern.test(label)||pattern.test(raw))?.[0];
  return key ? row[key] : null;
}
export function reusableAnswer(field,answers,job) {
  const matches = answers.filter(answer=>answer.verified && fieldQuestion(answer.questionKey)===fieldQuestion(field.label) &&
    (answer.type==='any'||answer.type===field.type) &&
    (answer.scope==='global' || answer.scope==='company'&&normalized(answer.context)===normalized(job.company) ||
     answer.scope==='role'&&normalized(answer.context)===normalized(job.title)));
  const specificity = {global:0,company:1,role:1};
  matches.sort((a,b)=>specificity[b.scope]-specificity[a.scope]);
  if (!matches.length || matches.slice(1).some(answer=>specificity[answer.scope]===specificity[matches[0].scope]&&answer.value!==matches[0].value)) return null;
  return matches[0];
}
export function createFillPlan(fields,{profile={},answers=[],job={},materials={},maps=[],drafts=[]}) {
  return fields.flatMap(field=>{
    if (field.filled && field.type!=='skill-picker' || field.disabled || field.consent || consentField(field.label) || field.type==='password') return [];
    const critical = field.critical || criticalField(field.label);
    const verified = reusableAnswer(field,answers,job);
    if (verified && field.type !== 'file' && !structuredValue(verified.value)) return [{id:field.id,value:verified.value,authority:'verified'}];
    if (critical) return [];
    const workValue=rowValue(field,profile);
    if (field.type==='checkbox' || field.type==='radio') return workValue==='true' && field.type==='checkbox'
      ? [{id:field.id,value:workValue,authority:'profile'}]:[];
    const key = fieldKey(field);
    if(key==='skills') {
      const skills=distinctValues(profile.skills);
      if(!skills.length||field.partial) return [];
      return [{id:field.id,value:skills.join(', '),...(field.type==='skill-picker'||field.multiple?{skills}:{}),authority:'profile'}];
    }
    if (field.type === 'file') return materials[key] ? [{id:field.id,file:materials[key],authority:'selected'}] : [];
    if (key==='coverText') return materials.coverText ? [{id:field.id,value:materials.coverText,authority:'reviewed'}] : [];
    const mapKey = maps.find(map=>map.id===field.id)?.key;
    const draft = drafts.find(item=>item.id===field.id)?.answer;
    const ordinary = Object.hasOwn(PROFILE_KEYS,mapKey) ? profile[mapKey] : undefined;
    const value = field.group ? workValue : (key && profile[key]) ?? ordinary ?? draft;
    return value !== undefined && value !== null && value !== '' && typeof value==='string' && !structuredValue(value) ? [{id:field.id,value:String(value),authority:'profile'}] : [];
  });
}

export const RECEIPT_SELECTORS = {
  greenhouse:['#application_confirmation','.application-confirmation','[data-testid="application-confirmation"]'],
  ashby:['[data-testid="application-submitted"]','[data-testid="application-confirmation"]','[class*="applicationSuccess"]'],
  lever:['.application-confirmation','.application-success','.posting-confirmation','[data-qa="thank-you"]'],
  workday:['[data-automation-id="applicationConfirmation"]','[data-automation-id="applicationSubmitted"]','[data-automation-id="jobApplicationConfirmation"]']
};
export function receiptSignature({provider,marker,text,finalVisible}) {
  if (!RECEIPT_SELECTORS[provider]?.includes(marker) || finalVisible) return null;
  const copy=String(text??'').slice(0,1000);
  if (/\b(?:not submitted|not received|submission failed|error submitting|unable to submit|has not been submitted|application was saved|draft application|if you submit|unable to receive|will appear|expected application)\b/i.test(copy)) return null;
  return copy.match(/\b(?:application (?:has been |was |is |successfully )?(?:submitted|received|complete)|(?:received|submitted) your application|thank you for (?:submitting your application|applying))\b/i)?.[0]??null;
}
