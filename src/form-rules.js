import { normalized } from './domain.js';

export const PROFILE_KEYS = {
  givenName:'First name',familyName:'Last name',fullName:'Full name',preferredName:'Preferred name',email:'Email',
  phone:'Phone',phoneCountry:'Phone country code',address1:'Address line 1',address2:'Address line 2',
  city:'City',region:'State or region',postal:'Postal code',country:'Country',linkedin:'LinkedIn URL',
  website:'Website or portfolio',github:'GitHub URL',currentEmployer:'Current employer',currentTitle:'Current title'
};

export function criticalField(value) {
  return /\b(?:authori[sz](?:ation|ed)|right to work|work eligibility|permission to work|work legally|legally permitted|petition on your behalf|visa|sponsor(?:ship)?|citizen(?:ship)?|permanent resident|h1b|h 1b|stem opt|opt|immigration|work permit|legal(?:ly)? eligible|eligible to work|employment eligibility|security clearance|criminal|convict|felony|drug test|background check|gender|sex(?:ual orientation)?|race|ethnic(?:ity)?|veteran|disabilit(?:y|ies)|eeo|diversity|demographic|age|birth|native american|indigenous|hispanic|latino|pronoun|government id|social security|ssn)\b/.test(normalized(value));
}
export function consentField(value) {
  return /\b(?:i agree|i accept|agree to|accept the|consent|certif(?:y|ication)|affirm|acknowledge|privacy policy|privacy notice|terms and conditions|signature|sign your|electronic sign|legally binding|accuracy of (?:the )?information)\b/.test(normalized(value));
}

export const fieldQuestion = value => normalized(value).replace(/\b(?:required|optional)$/, '').trim();
const transforms = {
  'given-name':'givenName','family-name':'familyName',name:'fullName',nickname:'preferredName',email:'email',tel:'phone',
  'tel-country-code':'phoneCountry','address-line1':'address1','street-address':'address1','address-line2':'address2',
  'address-level2':'city','address-level1':'region',country:'country','country-name':'country','postal-code':'postal',
  organization:'currentEmployer','organization-title':'currentTitle'
};
const rules = [
  ['givenName',/^(?:legal )?(?:first|given|forename) name$|^first$|^firstname$/],
  ['familyName',/^(?:legal )?(?:last|family|sur) name$|^surname$|^last$|^lastname$/],
  ['preferredName',/^(?:preferred|chosen|display) (?:first )?name$/],
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
  if (field.autocomplete && transforms[field.autocomplete]) return transforms[field.autocomplete];
  if (field.type === 'email') return 'email';
  if (field.type === 'tel') return 'phone';
  return rules.find(([,r]) => r.test(name) || r.test(identifiers))?.[0] ?? null;
}

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
  const time = date(label) ?? date(raw);
  if (time && row[time]) {
    if (label.includes('month')) return row[time].slice(5,7);
    if (label.includes('year')) return row[time].slice(0,4);
    return field.type === 'month' ? row[time].slice(0,7) : row[time];
  }
  const key = keys[field.group.kind]?.find(([,pattern])=>pattern.test(label)||pattern.test(raw))?.[0];
  return key ? row[key] : null;
}
export function reusableAnswer(field,answers,job) {
  const matches = answers.filter(answer=>answer.verified && answer.questionKey===fieldQuestion(field.label) &&
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
    if (field.filled || field.disabled || field.consent || consentField(field.label) || field.type==='password') return [];
    const critical = field.critical || criticalField(field.label);
    const verified = reusableAnswer(field,answers,job);
    if (verified && field.type !== 'file') return [{id:field.id,value:verified.value,authority:'verified'}];
    if (critical || field.type==='checkbox' || field.type==='radio') return [];
    const key = fieldKey(field);
    if (field.type === 'file') return materials[key] ? [{id:field.id,file:materials[key],authority:'selected'}] : [];
    if (key==='coverText') return materials.coverText ? [{id:field.id,value:materials.coverText,authority:'reviewed'}] : [];
    const mapKey = maps.find(map=>map.id===field.id)?.key;
    const draft = drafts.find(item=>item.id===field.id)?.answer;
    const ordinary = Object.hasOwn(PROFILE_KEYS,mapKey) ? profile[mapKey] : undefined;
    const value = rowValue(field,profile) ?? (key && profile[key]) ?? ordinary ?? draft;
    return value !== undefined && value !== null && value !== '' ? [{id:field.id,value:String(value),authority:'profile'}] : [];
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
